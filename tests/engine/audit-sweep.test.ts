import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sweepTree,
  signalsIn,
  isTestPath,
  summariseSignals,
  MAX_SWEEP_BYTES,
  SWEEP_RULES,
  redactSecretValues,
  type SignalKind,
} from "../../src/engine/audit/sweep.js";
import { FileAccessLog } from "../../src/engine/audit/inventory.js";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "sweep-test-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function write(rel: string, text: string | Buffer): void {
  const full = join(scratch, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

const kinds = (path: string, source: string): SignalKind[] => signalsIn(path, source).map((s) => s.kind);

describe("visiting every file", () => {
  // The whole point. Coverage stops being a claim the report makes and becomes
  // a ledger it can show, so every file needs exactly one recorded disposition.
  it("gives every file in the tree a disposition", () => {
    write("src/a.cs", "class A {}");
    write("src/b.ts", "export const b = 1;");
    write("docs/c.md", "# hi");
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.total).toBe(3);
    expect(result.dispositions.map((d) => d.path).sort()).toEqual(["docs/c.md", "src/a.cs", "src/b.ts"]);
    expect(result.dispositions.every((d) => d.outcome === "read")).toBe(true);
  });

  it("feeds the same access log coverage is computed from", () => {
    write("src/a.cs", "class A {}");
    const log = new FileAccessLog();
    sweepTree(scratch, log);
    expect(log.opened()).toEqual(new Set(["src/a.cs"]));
  });

  // Counting a PNG as covered would inflate the number this stage exists to
  // make trustworthy.
  it("records a binary as seen and not parsed, rather than as covered", () => {
    write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const log = new FileAccessLog();
    const result = sweepTree(scratch, log);
    expect(result.dispositions[0]?.outcome).toBe("binary");
    expect(result.read).toBe(0);
    expect(log.opened().size).toBe(0);
  });

  it("records an oversized file with its reason instead of reading it", () => {
    write("bundle.js", "x".repeat(MAX_SWEEP_BYTES + 10));
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.dispositions[0]?.outcome).toBe("too-large");
    expect(result.skipped).toBe(1);
  });

  // With the default --out the run's artifacts land inside the tree. A second
  // sweep over a one-file tree visited four files and raised a weak-crypto
  // candidate at sweep.json, whose excerpt was its own MD5 pattern from the
  // run before. The sweep must not audit itself.
  describe("the run's own artifacts", () => {
    const artifact = '{"signals":[{"kind":"weak-crypto","excerpt":"MD5.Create()"}]}';

    it("neither visits nor matches them when the run directory is the tree", () => {
      write("src/a.cs", "class A {}");
      write("sweep.json", artifact);
      write("run.json", '{"runId":"r"}');
      const log = new FileAccessLog();
      const result = sweepTree(scratch, log, { runDir: scratch });
      expect(result.dispositions.map((d) => d.path)).toEqual(["src/a.cs"]);
      expect(result.signals).toEqual([]);
      expect(log.opened()).toEqual(new Set(["src/a.cs"]));
    });

    it("skips them only inside the run directory, so the subject's own files are still counted", () => {
      write("src/a.cs", "class A {}");
      write(".audit/sweep.json", artifact);
      write("fixtures/sweep.json", artifact);
      const result = sweepTree(scratch, new FileAccessLog(), { runDir: join(scratch, ".audit") });
      expect(result.dispositions.map((d) => d.path).sort()).toEqual(["fixtures/sweep.json", "src/a.cs"]);
    });

    it("skips nothing when the run directory is outside the tree", () => {
      write("src/a.cs", "class A {}");
      write("sweep.json", artifact);
      const outside = sweepTree(scratch, new FileAccessLog(), { runDir: join(scratch, "..", "elsewhere") });
      const unspecified = sweepTree(scratch, new FileAccessLog());
      expect(outside.total).toBe(unspecified.total);
      expect(outside.dispositions.map((d) => d.path)).toContain("sweep.json");
    });
  });
});

/**
 * One row per rule: the shape it exists to catch, and the nearest idiom that
 * is safe and must NOT be caught. The negative is the calibration; a rule
 * without one has only been shown to fire, never shown to stop.
 */
interface Fixture {
  kind: SignalKind;
  path: string;
  fires: string;
  quiet: string;
}

const FIXTURES: Fixture[] = [
  // unvalidated-token
  { kind: "unvalidated-token", path: "Auth.cs", fires: "var token = handler.ReadJwtToken(rawToken);", quiet: "var principal = handler.ValidateToken(rawToken, parameters, out var validated);" },
  { kind: "unvalidated-token", path: "Auth.cs", fires: "var jwt = handler.ReadJsonWebToken(rawToken);", quiet: "var result = await handler.ValidateTokenAsync(rawToken, parameters);" },
  { kind: "unvalidated-token", path: "auth.ts", fires: "const claims = jwt.decode(rawToken);", quiet: "const claims = jwt.verify(rawToken, secret);" },
  // anonymous-endpoint
  { kind: "anonymous-endpoint", path: "OrderController.cs", fires: "[AllowAnonymous]", quiet: "[Authorize]" },
  { kind: "anonymous-endpoint", path: "Program.cs", fires: 'app.MapGet("/orders", GetOrders).AllowAnonymous();', quiet: 'app.MapGet("/orders", GetOrders).RequireAuthorization();' },
  // authorization-check
  { kind: "authorization-check", path: "OrderController.cs", fires: '[Authorize(Roles = "Admin")]', quiet: "[AllowAnonymous]" },
  { kind: "authorization-check", path: "Program.cs", fires: 'app.MapPost("/orders", CreateOrder).RequireAuthorization();', quiet: 'app.MapPost("/orders", CreateOrder).AllowAnonymous();' },
  // identity-from-request
  { kind: "identity-from-request", path: "TenantMiddleware.cs", fires: 'var tenant = Request.Headers["X-Tenant-Id"];', quiet: 'var tenant = User.FindFirst("tenant")?.Value;' },
  { kind: "identity-from-request", path: "tenant.ts", fires: 'const tenant = req.headers["x-tenant-id"];', quiet: "const tenant = req.user.tenantId;" },
  // http-endpoint
  { kind: "http-endpoint", path: "OrderController.cs", fires: '[HttpGet("{id}")]', quiet: "[ProducesResponseType(200)]" },
  { kind: "http-endpoint", path: "OrderController.cs", fires: '[Route("api/orders")]', quiet: "[ApiController]" },
  { kind: "http-endpoint", path: "Program.cs", fires: 'app.MapGet("/orders/{id}", GetOrderById);', quiet: 'app.MapGroup("/orders");' },
  { kind: "http-endpoint", path: "app/orders/route.ts", fires: "export async function GET(request: Request) {", quiet: "export async function loadOrders() {" },
  { kind: "http-endpoint", path: "orders.ts", fires: 'router.get("/orders", listOrders);', quiet: 'router.use("/orders", ordersRouter);' },
  // raw-sql: statement shape, concatenated with input, not in a log call
  { kind: "raw-sql", path: "OrderRepository.cs", fires: 'var sql = "SELECT * FROM Orders WHERE Id = " + orderId;', quiet: 'var sql = "SELECT * FROM Orders WHERE Id = @id";' },
  { kind: "raw-sql", path: "OrderRepository.cs", fires: 'var rows = db.Orders.FromSqlRaw($"SELECT * FROM Orders WHERE Id = {orderId}");', quiet: 'var rows = db.Orders.FromSqlInterpolated($"SELECT * FROM Orders WHERE Id = {orderId}");' },
  { kind: "raw-sql", path: "OrderRepository.cs", fires: 'db.Database.ExecuteSqlRaw($"EXEC ArchiveOrder {orderId}");', quiet: 'db.Database.ExecuteSqlRaw("EXEC ArchiveOrder {0}", orderId);' },
  { kind: "raw-sql", path: "orders.py", fires: 'cursor.execute("SELECT * FROM orders WHERE id = %s" % order_id)', quiet: 'cursor.execute("SELECT * FROM orders WHERE id = %s", (order_id,))' },
  // weak-crypto
  { kind: "weak-crypto", path: "Digest.cs", fires: "using var md5 = MD5.Create();", quiet: "using var sha = SHA256.Create();" },
  { kind: "weak-crypto", path: "Digest.cs", fires: "using var sha = new SHA1Managed();", quiet: "using var sha = new SHA256Managed();" },
  { kind: "weak-crypto", path: "Digest.cs", fires: "using var md5 = new MD5CryptoServiceProvider();", quiet: "using var aes = new AesCryptoServiceProvider();" },
  { kind: "weak-crypto", path: "digest.ts", fires: 'const digest = createHash("md5").update(body).digest("hex");', quiet: 'const digest = createHash("sha256").update(body).digest("hex");' },
  // disabled-cert-validation
  { kind: "disabled-cert-validation", path: "Client.cs", fires: "ServicePointManager.ServerCertificateValidationCallback += (s, c, ch, e) => true;", quiet: "handler.SslProtocols = SslProtocols.Tls12;" },
  { kind: "disabled-cert-validation", path: "client.ts", fires: "const agent = new https.Agent({ rejectUnauthorized: false });", quiet: "const agent = new https.Agent({ keepAlive: true });" },
  // permissive-cors
  { kind: "permissive-cors", path: "Program.cs", fires: "policy.AllowAnyOrigin().AllowAnyHeader();", quiet: 'policy.WithOrigins("https://app.example.com").AllowAnyHeader();' },
  // config-precedence
  { kind: "config-precedence", path: "Program.cs", fires: 'builder.Configuration.AddJsonFile("appsettings.Test.json", optional: true);', quiet: 'builder.Configuration.AddJsonFile($"appsettings.{env}.json", optional: true);' },
  { kind: "config-precedence", path: "Dockerfile", fires: "COPY appsettings.Test.json appsettings.json", quiet: "COPY appsettings.json appsettings.json" },
  // insecure-direct-object-reference
  { kind: "insecure-direct-object-reference", path: "OrderService.cs", fires: "public Task<Order> GetOrderById(string orderId) => _store.GetItemByIdAsync<Order>(orderId);", quiet: "public Task<Order> GetByTenantId(string tenantId) => _store.Query<Order>().Where(o => o.TenantId == tenantId).FirstAsync();" },
  // csrf-token-validated
  { kind: "csrf-token-validated", path: "OrderController.cs", fires: "[ValidateAntiForgeryToken]", quiet: "[IgnoreAntiforgeryToken]" },
  // debug-enabled
  { kind: "debug-enabled", path: "Web.config", fires: '<compilation debug="true" targetFramework="4.8" />', quiet: '<compilation debug="false" targetFramework="4.8" />' },
  { kind: "debug-enabled", path: "Program.cs", fires: "app.UseDeveloperExceptionPage();", quiet: "if (app.Environment.IsDevelopment()) app.UseDeveloperExceptionPage();" },
  // insecure-cookie
  { kind: "insecure-cookie", path: "Program.cs", fires: "options.Cookie.HttpOnly = false;", quiet: "options.Cookie.HttpOnly = true;" },
  // weak-password-hash
  { kind: "weak-password-hash", path: "PasswordHasher.cs", fires: "byte[] hash = SHA256.Create().ComputeHash(passwordBytes);", quiet: "byte[] hash = KeyDerivation.Pbkdf2(password, salt, KeyDerivationPrf.HMACSHA256, 100_000, 32);" },
  // sensitive-field
  { kind: "sensitive-field", path: "Patient.cs", fires: "public DateTime DateOfBirth { get; set; }", quiet: "public DateTime CreatedAt { get; set; }" },
  // phi-in-log
  { kind: "phi-in-log", path: "PatientService.cs", fires: '_logger.LogInformation("Loaded patient {Ssn}", patient.Ssn);', quiet: '_logger.LogInformation("SSN lookup for patient {Id}", patient.Id);' },
  // hardcoded-secret
  { kind: "hardcoded-secret", path: "appsettings.json", fires: '"ConnectionString": "Server=db;Database=orders;User Id=app;Password=Tr0ub4dor&3;"', quiet: '"ConnectionString": "Server=db;Database=orders;User Id=app;Password=${DB_PASSWORD};"' },
  // insecure-deserialization
  { kind: "insecure-deserialization", path: "Cache.cs", fires: "var formatter = new BinaryFormatter();", quiet: "var order = JsonSerializer.Deserialize<Order>(payload);" },
  { kind: "insecure-deserialization", path: "orders.py", fires: "order = pickle.loads(payload)", quiet: "order = json.loads(payload)" },
  // xxe
  { kind: "xxe", path: "Import.cs", fires: "settings.DtdProcessing = DtdProcessing.Parse;", quiet: "settings.DtdProcessing = DtdProcessing.Prohibit;" },
  // path-traversal
  { kind: "path-traversal", path: "Files.cs", fires: "var full = Path.Combine(_root, fileName);", quiet: "var full = Path.Combine(_root, Path.GetFileName(fileName));" },
  // ssrf
  { kind: "ssrf", path: "Webhooks.cs", fires: 'var response = await client.GetAsync($"{callbackUrl}/notify");', quiet: 'var response = await client.GetAsync($"{_baseUrl}/orders/{orderId}");' },
  // xss-sink
  { kind: "xss-sink", path: "Order.tsx", fires: "<div dangerouslySetInnerHTML={{ __html: note }} />", quiet: "<div>{note}</div>" },
  // token-in-web-storage
  { kind: "token-in-web-storage", path: "session.ts", fires: 'localStorage.setItem("access_token", rawToken);', quiet: 'localStorage.setItem("theme", "dark");' },
  // rate-limit-absent
  { kind: "rate-limit-absent", path: "AuthController.cs", fires: '[HttpPost("login")]', quiet: '[EnableRateLimiting("auth")]\n[HttpPost("login")]' },
];

/**
 * The standard each kind cites. Kept as a table here, independent of the
 * rules, so a rule that drifts to the wrong category fails a test rather than
 * reaching a report: the first cut cited Security Misconfiguration for SQL
 * injection, which told the reader the wrong thing to fix.
 */
const STANDARDS: Record<SignalKind, { cwe: string; owasp?: string }> = {
  "unvalidated-token": { cwe: "CWE-347", owasp: "API2:2023 Broken Authentication" },
  "anonymous-endpoint": { cwe: "CWE-306", owasp: "API2:2023 Broken Authentication" },
  "authorization-check": { cwe: "CWE-862", owasp: "API5:2023 Broken Function Level Authorization" },
  "identity-from-request": { cwe: "CWE-639", owasp: "API1:2023 Broken Object Level Authorization" },
  "http-endpoint": { cwe: "CWE-284" },
  "raw-sql": { cwe: "CWE-89" },
  "weak-crypto": { cwe: "CWE-327" },
  "disabled-cert-validation": { cwe: "CWE-295", owasp: "API8:2023 Security Misconfiguration" },
  "permissive-cors": { cwe: "CWE-942", owasp: "API8:2023 Security Misconfiguration" },
  "config-precedence": { cwe: "CWE-15", owasp: "API8:2023 Security Misconfiguration" },
  "insecure-direct-object-reference": { cwe: "CWE-639", owasp: "API1:2023 Broken Object Level Authorization" },
  "csrf-token-validated": { cwe: "CWE-352" },
  "debug-enabled": { cwe: "CWE-489", owasp: "API8:2023 Security Misconfiguration" },
  "insecure-cookie": { cwe: "CWE-1004", owasp: "API8:2023 Security Misconfiguration" },
  "weak-password-hash": { cwe: "CWE-916" },
  "sensitive-field": { cwe: "CWE-311" },
  "phi-in-log": { cwe: "CWE-532" },
  "hardcoded-secret": { cwe: "CWE-798" },
  "insecure-deserialization": { cwe: "CWE-502" },
  xxe: { cwe: "CWE-611" },
  "path-traversal": { cwe: "CWE-22" },
  ssrf: { cwe: "CWE-918", owasp: "API7:2023 Server Side Request Forgery" },
  "xss-sink": { cwe: "CWE-79" },
  "token-in-web-storage": { cwe: "CWE-922" },
  "rate-limit-absent": { cwe: "CWE-307", owasp: "API2:2023 Broken Authentication" },
};

describe("what the sweep can establish without a model", () => {
  it.each(FIXTURES)("finds $kind in: $fires", ({ kind, path, fires }) => {
    expect(kinds(path, fires)).toContain(kind);
  });

  it.each(FIXTURES)("leaves the nearest safe idiom alone for $kind: $quiet", ({ kind, path, quiet }) => {
    expect(kinds(path, quiet)).not.toContain(kind);
  });

  // A rule with a positive fixture and no negative has been shown to fire and
  // never shown to stop. The rule table is exported so this can be checked
  // against what actually ships rather than against a list kept by hand.
  it("has at least one fixture pair for every rule of every kind", () => {
    for (const kind of new Set(SWEEP_RULES.map((r) => r.kind))) {
      const rules = SWEEP_RULES.filter((r) => r.kind === kind).length;
      const fixtures = FIXTURES.filter((f) => f.kind === kind).length;
      expect(fixtures, `${kind}: ${rules} rule(s), ${fixtures} fixture(s)`).toBeGreaterThanOrEqual(rules);
    }
  });

  // Injection is not misconfiguration; a missing authentication is not a
  // function-level authorization failure. Every rule of a kind cites the same
  // pair, and the pair is the one in the table.
  it("cites the standard in the table, on every rule of the kind", () => {
    for (const rule of SWEEP_RULES) {
      const expected = STANDARDS[rule.kind];
      expect({ kind: rule.kind, cwe: rule.cwe, owasp: rule.owasp }).toEqual({ kind: rule.kind, ...expected });
    }
  });

  it("covers every kind in the standards table with a rule", () => {
    const ruled = new Set(SWEEP_RULES.map((r) => r.kind));
    for (const kind of Object.keys(STANDARDS) as SignalKind[]) expect(ruled.has(kind), kind).toBe(true);
  });

  // Every signal cites a standard, so a finding rests on something published
  // rather than on our opinion of what looks wrong.
  it("carries a CWE on every signal", () => {
    const found = signalsIn("C.cs", "[AllowAnonymous]\n[HttpPost]\nvar x = handler.ReadJwtToken(t);");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => /^CWE-\d+$/.test(s.cwe))).toBe(true);
  });

  it("emits one signal per kind per line, however many rules of that kind match", () => {
    const found = signalsIn("Program.cs", 'config.AddJsonFile("appsettings.Test.json")');
    expect(found.filter((s) => s.kind === "config-precedence")).toHaveLength(1);
  });

  it("puts the raw line in the excerpt, not the stripped one", () => {
    const [found] = signalsIn("Auth.cs", 'var t = handler.ReadJwtToken(raw); // "temporary"');
    expect(found?.excerpt).toBe('var t = handler.ReadJwtToken(raw); // "temporary"');
  });
});

describe("what a rule is allowed to read", () => {
  // A comment describing code is not code. A rule that fires on prose produces
  // a finding nobody can act on.
  it("does not fire on a line comment", () => {
    expect(signalsIn("C.cs", "// [AllowAnonymous] was removed last year")).toEqual([]);
  });

  it("does not fire on a trailing comment", () => {
    expect(kinds("Program.cs", 'app.UseHsts(); // was app.UseDeveloperExceptionPage()')).not.toContain("debug-enabled");
  });

  it("does not fire inside a block comment that opened on an earlier line", () => {
    const source = ["/*", "  var t = handler.ReadJwtToken(raw);", "  builder.AllowAnyOrigin();", "*/", "var ok = 1;"].join("\n");
    expect(signalsIn("C.cs", source)).toEqual([]);
  });

  it("resumes matching after the block comment closes", () => {
    const source = ["/* legacy */ var t = handler.ReadJwtToken(raw);"].join("\n");
    expect(kinds("C.cs", source)).toContain("unvalidated-token");
  });

  it("does not fire on an XML comment in a config file", () => {
    expect(signalsIn("Web.config", '<!-- <compilation debug="true" /> -->')).toEqual([]);
  });

  // A SQL keyword in a log message is a message, not a query. The first cut
  // raised raw-sql on `LogInformation("Update user " + id)`.
  it.each([
    '_logger.LogInformation("Update user " + userId);',
    'logger.info("select * from orders where id = " + orderId);',
    'throw new InvalidOperationException("Update failed for " + orderId);',
    'throw new ArgumentException("Select an order from the list: " + name);',
    'var label = "SELECT * FROM Orders" + " WHERE Id = @id";',
  ])("does not raise raw-sql on prose or on two literals joined: %s", (line) => {
    expect(kinds("OrderService.cs", line)).not.toContain("raw-sql");
  });

  it("does not raise weak-crypto on a string that names the algorithm", () => {
    expect(kinds("Digest.cs", '_logger.LogWarning("MD5 checksum mismatch for {File}", name);')).not.toContain("weak-crypto");
  });

  // A README that says "we still hash with MD5" is prose about the code, and a
  // candidate raised on it cannot be fixed at the cited line.
  it("reads no rule against markdown", () => {
    expect(signalsIn("README.md", "We hash with MD5 and read the SSN off the request header.")).toEqual([]);
  });

  // `$"Patient {patient.Ssn}"` passes the field even though it sits between
  // quotes; a template's `{Ssn}` is a name and passes nothing.
  it("keeps interpolation holes as code and template holes as text", () => {
    expect(kinds("Patient.cs", 'Console.WriteLine($"Patient {patient.Ssn}");')).toContain("phi-in-log");
    expect(kinds("Patient.cs", 'Console.WriteLine("Patient {Ssn}");')).not.toContain("phi-in-log");
    expect(kinds("patient.ts", "console.log(`Patient ${patient.ssn}`);")).toContain("phi-in-log");
  });

  // The header name is the evidence, and it is a literal, so the rule that
  // needs it reads the line with literals intact.
  it("still reads a literal when the evidence lives inside one", () => {
    expect(kinds("Tenant.cs", 'var t = Request.Headers["X-Tenant-Id"];')).toContain("identity-from-request");
  });

  it("treats # as a comment in languages where it is one, and not in C#", () => {
    expect(signalsIn("deploy.sh", "# COPY appsettings.Test.json to the image")).toEqual([]);
    expect(kinds("Program.cs", "#if DEBUG\napp.UseDeveloperExceptionPage();")).toContain("debug-enabled");
  });
});

describe("guards the rule must respect", () => {
  // The template every new project ships with.
  it("ignores a developer exception page guarded by IsDevelopment on the lines above", () => {
    const source = ["if (app.Environment.IsDevelopment())", "{", "    app.UseDeveloperExceptionPage();", "}"].join("\n");
    expect(kinds("Program.cs", source)).not.toContain("debug-enabled");
  });

  it("still raises the developer exception page when the guard is out of reach", () => {
    const source = ["if (app.Environment.IsDevelopment())", "{", "    app.UseSwagger();", "    app.UseSwaggerUI();", "}", "app.UseDeveloperExceptionPage();"].join("\n");
    expect(kinds("Program.cs", source)).toContain("debug-enabled");
  });

  it("ignores a .csproj item that only copies the test settings file", () => {
    expect(signalsIn("Orders.csproj", '<Content Include="appsettings.Test.json" CopyToOutputDirectory="Always" />')).toEqual([]);
  });

  it("counts a credential route only when no throttle sits beside it", () => {
    const throttled = ['[EnableRateLimiting("auth")]', "[HttpPost(\"login\")]"].join("\n");
    const bare = ["[HttpPost(\"login\")]"].join("\n");
    expect(kinds("AuthController.cs", throttled)).not.toContain("rate-limit-absent");
    expect(kinds("AuthController.cs", bare)).toContain("rate-limit-absent");
  });

  it("sees a throttle on the minimal-API line after the route", () => {
    const source = ['app.MapPost("/login", Login)', '    .RequireRateLimiting("auth");'].join("\n");
    expect(kinds("Program.cs", source)).not.toContain("rate-limit-absent");
  });
});

describe("the idioms the first cut missed", () => {
  it.each([
    ["dateOfBirth", true],
    ["date_of_birth", true],
    ["DOB", true],
    ["mrn", true],
    ["Npi", true],
    ["PatientId", false],
    ["dobbin", false],
  ])("recognises %s as a sensitive field: %s", (name, sensitive) => {
    expect(kinds("patient.ts", `const value = record.${name};`).includes("sensitive-field")).toBe(sensitive);
  });

  it("raises phi-in-log on the value, not on a message that names the field", () => {
    expect(kinds("Patient.cs", '_logger.LogDebug("dob {Dob}", patient.DateOfBirth);')).toContain("phi-in-log");
    expect(kinds("Patient.cs", '_logger.LogDebug("date of birth missing for {Id}", id);')).not.toContain("phi-in-log");
  });

  it.each([
    'localStorage.setItem("jwt", rawToken);',
    "localStorage.setItem(AUTH_TOKEN_KEY, rawToken);",
    "localStorage.authToken = rawToken;",
    'window.sessionStorage.setItem("token", rawToken);',
  ])("raises token-in-web-storage on %s", (line) => {
    expect(kinds("session.ts", line)).toContain("token-in-web-storage");
  });

  it("ignores a placeholder or a reference where a secret would be", () => {
    for (const line of [
      '"ClientSecret": "<set in key vault>"',
      '"ClientSecret": "@Microsoft.KeyVault(SecretUri=https://kv.example.com/secrets/client)"',
      '"ApiKey": ""',
      '"PasswordResetUrl": "https://app.example.com/reset"',
    ]) {
      expect(kinds("appsettings.json", line), line).not.toContain("hardcoded-secret");
    }
    expect(kinds(".env", "DB_PASSWORD=Tr0ub4dor&3")).toContain("hardcoded-secret");
    expect(kinds(".env.example", "DB_PASSWORD=Tr0ub4dor&3")).not.toContain("hardcoded-secret");
  });

  it("raises hardcoded-secret only in configuration, not in a source file naming the same key", () => {
    expect(kinds("Db.cs", 'var cs = "Server=db;Password=Tr0ub4dor&3;";')).not.toContain("hardcoded-secret");
  });

  it("raises ssrf on a caller-supplied host, whichever way the URL is built", () => {
    expect(kinds("Hooks.cs", 'await client.PostAsync(callbackUrl + "/notify", content);')).toContain("ssrf");
    expect(kinds("Hooks.cs", "await client.GetAsync(new Uri(request.CallbackUrl));")).toContain("ssrf");
    expect(kinds("hooks.ts", "const r = await fetch(`${target}/health`);")).toContain("ssrf");
    expect(kinds("hooks.ts", "const r = await fetch(`${process.env.API_BASE}/health`);")).not.toContain("ssrf");
    expect(kinds("hooks.ts", 'const r = await fetch("/api/orders/" + orderId);')).not.toContain("ssrf");
  });

  it("raises path-traversal on a request-bound value and not on a fixed path", () => {
    expect(kinds("files.ts", "const data = fs.readFileSync(path.join(root, req.params.name));")).toContain("path-traversal");
    expect(kinds("Files.cs", 'var html = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "templates", "order.html"));')).not.toContain("path-traversal");
  });

  it("raises insecure-deserialization on TypeNameHandling that trusts the payload", () => {
    expect(kinds("Json.cs", "settings.TypeNameHandling = TypeNameHandling.All;")).toContain("insecure-deserialization");
    expect(kinds("Json.cs", "settings.TypeNameHandling = TypeNameHandling.None;")).not.toContain("insecure-deserialization");
  });

  it("raises xss-sink on a value reaching innerHTML, and not on clearing it", () => {
    expect(kinds("order.ts", "el.innerHTML = note;")).toContain("xss-sink");
    expect(kinds("order.ts", 'el.innerHTML = "";')).not.toContain("xss-sink");
  });

  it("raises xxe on a resolver that will fetch what the DTD names", () => {
    expect(kinds("Import.cs", "doc.XmlResolver = new XmlUrlResolver();")).toContain("xxe");
    expect(kinds("Import.cs", "doc.XmlResolver = null;")).not.toContain("xxe");
  });
});

describe("what counts as test code", () => {
  // A fixture is not production risk surface. These files are still visited and
  // still counted as covered; what they do not do is generate findings.
  it.each(["tests/Foo.cs", "src/FooTests.cs", "src/__tests__/a.ts", "src/a.test.ts", "Orders.Tests/OrderServiceTests.cs", "spec/orders_spec.rb", "e2e/x.ts"])(
    "produces no signals from test code: %s",
    (path) => {
      expect(signalsIn(path, "[AllowAnonymous]\nvar t = handler.ReadJwtToken(x);")).toEqual([]);
      expect(isTestPath(path)).toBe(true);
    },
  );

  // The first cut muted these. `Contest.cs` matched `/Tests?\.cs$/i`, and a
  // production `Mocks/` directory of API doubles matched a segment list.
  it.each([
    "src/Services/ContestService.cs",
    "src/Models/Contest.cs",
    "src/Models/Contests.cs",
    "src/Models/LabTest.cs",
    "src/Mocks/PaymentGatewayMock.cs",
    "src/Fixtures/FixtureLoader.cs",
    "src/Testing/TestHarness.cs",
    "src/latest.ts",
  ])("does not mistake production code for test code: %s", (path) => {
    expect(isTestPath(path)).toBe(false);
    const defect = path.endsWith(".ts") ? "const claims = jwt.decode(rawToken);" : "var t = handler.ReadJwtToken(rawToken);";
    expect(kinds(path, defect)).toContain("unvalidated-token");
  });

  it("still counts test files as visited, and says why they produced nothing", () => {
    write("tests/FooTests.cs", "[AllowAnonymous]");
    write("src/Foo.cs", "class Foo {}");
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.read).toBe(2);
    expect(result.signals).toEqual([]);
    const byPath = new Map(result.dispositions.map((d) => [d.path, d]));
    expect(byPath.get("tests/FooTests.cs")).toMatchObject({ outcome: "read", signals: 0, suppressed: "test-path" });
    expect(byPath.get("src/Foo.cs")?.suppressed).toBeUndefined();
  });
});

describe("separating surface from defects", () => {
  // Hundreds of by-id fetches against a comparable number of authorization
  // checks is a statement worth making. Calling every one of them a defect
  // would bury the handful that are.
  it("classes an endpoint as surface and an unvalidated token as a defect", () => {
    const surface = signalsIn("C.cs", "[HttpGet]");
    const defect = signalsIn("C.cs", "var t = handler.ReadJwtToken(x);");
    expect(surface[0]?.signalClass).toBe("surface");
    expect(defect[0]?.signalClass).toBe("defect");
  });

  // The kind is named for what the line shows. A count of anti-forgery
  // attributes under a heading that says "missing" reads as its opposite.
  it("names the anti-forgery count for what it observes", () => {
    const [found] = signalsIn("C.cs", "[ValidateAntiForgeryToken]");
    expect(found?.kind).toBe("csrf-token-validated");
    expect(found?.signalClass).toBe("surface");
  });

  it("keeps the credential-route count as surface, because the throttle may live in middleware", () => {
    expect(signalsIn("AuthController.cs", '[HttpPost("login")]').find((s) => s.kind === "rate-limit-absent")?.signalClass).toBe("surface");
  });

  it("puts defects before surface in the summary, however common the surface", () => {
    const signals = [
      ...Array.from({ length: 50 }, () => signalsIn("C.cs", "[HttpGet]")).flat(),
      ...signalsIn("C.cs", "var t = handler.ReadJwtToken(x);"),
    ];
    expect(summariseSignals(signals)[0]?.signalClass).toBe("defect");
  });
});

/* ── Secret values never reach an artifact (OGE-2754) ───────────────────────── */

/**
 * A signal's excerpt is the matched line, and for a secret rule the matched
 * line IS the secret. `sweep.json` defaults into the acquired tree, so an audit
 * reporting an exposed credential took a second copy of it.
 *
 * These assert on the ABSENCE of the value in the serialised result, not on the
 * presence of the mask. A mask-present test passes while the secret is still in
 * the file beside it, which is exactly the failure being fixed.
 */
describe("secret values in artifacts", () => {
  // High entropy, no shape any pattern in sanitize.ts recognises. If this
  // survives, it survives because the rule's own capture group hid it, which is
  // the layer that has to work for keys we cannot pattern-match.
  const VALUE = "Zq7NfE2kR9tXwB4mHs6Lp1Yc3Vd8Ja5G";

  it("keeps the value out of every part of the serialised sweep", () => {
    write("api/appsettings.json", `{\n  "ClientSecret": "${VALUE}"\n}\n`);
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.signals.some((s) => s.kind === "hardcoded-secret")).toBe(true);
    // The whole artifact, not the excerpt field: a value copied into some other
    // field later is the same leak and this has to fail then too.
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it("keeps a connection-string key out too, where the value has no delimiter of its own", () => {
    write("api/appsettings.json", `{\n  "Storage": "AccountEndpoint=https://x.example/;AccountKey=${VALUE};"\n}\n`);
    const result = sweepTree(scratch, new FileAccessLog());
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  // Hiding the value is only useful if the reader can still act on the signal.
  it("leaves the key name, path and line readable", () => {
    write("api/appsettings.json", `{\n  "ClientSecret": "${VALUE}"\n}\n`);
    const signal = sweepTree(scratch, new FileAccessLog()).signals.find(
      (s) => s.kind === "hardcoded-secret",
    );
    expect(signal?.path).toBe("api/appsettings.json");
    expect(signal?.line).toBe(2);
    expect(signal?.excerpt).toContain("ClientSecret");
  });

  // The documented way of NOT committing a secret. Masking it would teach the
  // reader to skip the line that is real.
  it("leaves a placeholder readable", () => {
    write("api/appsettings.json", '{\n  "ClientSecret": "${CLIENT_SECRET}"\n}\n');
    const result = sweepTree(scratch, new FileAccessLog());
    const excerpts = result.signals.map((s) => s.excerpt).join("\n");
    if (excerpts !== "") expect(excerpts).toContain("CLIENT_SECRET");
    expect(excerpts).not.toContain("<secret-hidden>");
  });

  /**
   * The second layer, tested where it can fail.
   *
   * The capture groups only look at an assignment whose key names a secret. A
   * credential can also sit on a line that some other rule matched, in a shape
   * no capture group is pointed at, and `maskSecrets` is what covers that. A
   * sweep-level test of it would be vacuous, because these shapes fire no rule
   * of their own and an empty signal list trivially contains no secret.
   */
  it("masks credential shapes the capture groups are not pointed at", () => {
    const shaped = [
      `https://svc:${VALUE}@nuget.example/v3/index.json`,
      `sk-ant-api03-${VALUE}`,
      `ghp_${VALUE}`,
    ];
    for (const line of shaped) expect(redactSecretValues(line)).not.toContain(VALUE);
  });

  // The layers overlap on purpose, and the overlap has to actually hold: a
  // connection string reached by either route must come out hidden.
  it("hides a credential on a line another rule also matched", () => {
    const line = `{ "PatientName": "x", "Storage": "Server=db;Password=${VALUE};" }`;
    const signals = signalsIn("api/appsettings.json", line);
    expect(signals.length).toBeGreaterThan(0);
    expect(JSON.stringify(signals)).not.toContain(VALUE);
  });

  /**
   * The redactor needs its own global regexes. Sharing the detector's objects
   * and adding `/g` makes `lastIndex` persist across `.exec` calls, so the
   * detector skips every other line it is asked about. That reads as flaky rule
   * coverage and points nowhere near the redactor.
   */
  it("detects a secret on every call, not every other one", () => {
    const line = `{ "ClientSecret": "${VALUE}" }`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const kinds = signalsIn("api/appsettings.json", line).map((s) => s.kind);
      expect(kinds).toContain("hardcoded-secret");
    }
  });
});
