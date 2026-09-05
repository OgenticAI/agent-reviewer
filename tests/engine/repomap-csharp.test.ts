import { describe, it, expect } from "vitest";
import { extractTags, type Tag } from "../../src/engine/repomap/tags.js";
import { rankFiles } from "../../src/engine/repomap/rank.js";
import { renderRepoMap } from "../../src/engine/repomap/render.js";

/**
 * C# tag extraction for the repo map.
 *
 * The subject this engine targets is a .NET API plus a TypeScript client. Before
 * the C# backend the map covered the client only, and an investigation that
 * asked "who is registered for IOrderRepository" had to spend tool turns to
 * find out. These pin what the backend must see: every declaration kind with
 * its line and signature, attributes and DI registrations as references, and
 * the three ways a regex extractor lies (comments, strings, local functions).
 */

const defs = (tags: Tag[]) => tags.filter((t) => t.kind === "def");
const refs = (tags: Tag[]) => tags.filter((t) => t.kind === "ref");
const defNamed = (tags: Tag[], name: string) => defs(tags).find((t) => t.name === name);
const refNames = (tags: Tag[]) => new Set(refs(tags).map((t) => t.name));

describe("C# definitions", () => {
  const source = [
    "using System;",
    "",
    "namespace Acme.Orders.Services",
    "{",
    "    public abstract partial class OrderServiceBase<TOrder> where TOrder : class",
    "    {",
    "        public OrderServiceBase(IOrderRepository repository)",
    "        {",
    "            _repository = repository;",
    "        }",
    "",
    "        public event EventHandler<OrderEventArgs> OrderPlaced;",
    "",
    "        public string Name { get; set; }",
    "",
    "        protected static async Task<OrderDto> LoadAsync<T>(int id)",
    "        {",
    "            return await _repository.GetAsync(id);",
    "        }",
    "",
    "        internal void Notify(OrderDto order) => OrderPlaced?.Invoke(this, null);",
    "",
    "        private IOrderRepository _repository;",
    "    }",
    "",
    "    public sealed class OrderService : OrderServiceBase<OrderDto>",
    "    {",
    "        public OrderService(IOrderRepository repository) : base(repository) { }",
    "    }",
    "",
    "    public static class OrderExtensions { }",
    "    public interface IOrderRepository { Task<OrderDto> GetAsync(int id); }",
    "    public record OrderDto(int Id, string Name);",
    "    public readonly struct OrderId { }",
    "    public enum OrderStatus { Pending, Shipped }",
    "    public delegate void OrderHandler(OrderDto order);",
    "}",
  ].join("\n");
  const tags = extractTags("src/Orders/OrderService.cs", source);

  it.each([
    ["Acme.Orders.Services", 3, "namespace Acme.Orders.Services"],
    ["OrderServiceBase", 5, "public abstract partial class OrderServiceBase<TOrder>"],
    ["OrderService", 26, "public sealed class OrderService : OrderServiceBase<OrderDto>"],
    ["OrderExtensions", 31, "public static class OrderExtensions"],
    ["IOrderRepository", 32, "public interface IOrderRepository"],
    ["OrderDto", 33, "public record OrderDto(int Id, string Name);"],
    ["OrderId", 34, "public readonly struct OrderId"],
    ["OrderStatus", 35, "public enum OrderStatus"],
    ["OrderHandler", 36, "public delegate void OrderHandler(OrderDto order);"],
    ["OrderPlaced", 12, "public event EventHandler<OrderEventArgs> OrderPlaced;"],
    ["Name", 14, "public string Name { get; set; }"],
    ["LoadAsync", 16, "protected static async Task<OrderDto> LoadAsync<T>(int id)"],
    ["Notify", 21, "internal void Notify(OrderDto order)"],
  ])("finds %s on line %i with its signature", (name, line, signature) => {
    const def = defNamed(tags, name);
    expect(def).toBeDefined();
    expect(def!.line).toBe(line);
    expect(def!.signature).toContain(signature);
  });

  it("finds a constructor for each class, on the constructor's line", () => {
    const ctors = defs(tags).filter((t) => t.name === "OrderServiceBase" || t.name === "OrderService");
    expect(ctors.map((t) => t.line).sort((a, b) => a - b)).toEqual([5, 7, 26, 28]);
    expect(ctors.find((t) => t.line === 28)!.signature).toContain("public OrderService(IOrderRepository repository)");
  });

  it("finds the interface even when its body sits on the same line", () => {
    // `GetAsync` lives inside a one-line body, which a line extractor cannot
    // see as a member; the method still reaches the graph as a ref.
    expect(defNamed(tags, "IOrderRepository")).toBeDefined();
    expect(refs(tags).some((t) => t.name === "GetAsync" && t.line === 32)).toBe(true);
  });

  it("does not report a field, a statement, or a base() call as a def", () => {
    const names = defs(tags).map((t) => t.name);
    expect(names).not.toContain("_repository");
    expect(names).not.toContain("base");
    expect(names).not.toContain("return");
  });
});

describe("C# member visibility and shape", () => {
  it("accepts every access modifier, static, async and generics on a method", () => {
    const source = [
      "public class Repo {",
      "    public void A() { }",
      "    private void B() { }",
      "    protected void C() { }",
      "    internal void D() { }",
      "    public static void E() { }",
      "    public async Task F() { }",
      "    public T G<T>(T x) where T : class => x;",
      "    protected internal virtual IReadOnlyList<Order?> H(int[] ids) => null;",
      "    void I() { }",
      "}",
    ].join("\n");
    const names = defs(extractTags("Repo.cs", source)).map((t) => t.name);
    expect(names).toEqual(["Repo", "A", "B", "C", "D", "E", "F", "G", "H", "I"]);
  });

  it("finds auto, expression-bodied and explicit-interface properties", () => {
    const source = [
      "public class Order : IHasId {",
      "    public int Id { get; init; }",
      "    public string Label => $\"Order {Id}\";",
      "    int IHasId.Key => Id;",
      "    public OrderStatus Status",
      "    {",
      "        get => _status;",
      "        set { _status = value; }",
      "    }",
      "}",
    ].join("\n");
    const names = defs(extractTags("Order.cs", source)).map((t) => t.name);
    expect(names).toEqual(["Order", "Id", "Label", "Key", "Status"]);
  });

  it("names an expression-bodied member after itself, not after a generic call in its body", () => {
    // `DbSet<Order> Orders => Set<Order>()` has nothing but `=>` between the
    // member's type arguments and the body's; a type span that crossed it made
    // the property a method named Set.
    const source = [
      "public class OrdersDbContext : DbContext",
      "{",
      "    public DbSet<Order> Orders => Set<Order>();",
      "    public IReadOnlyList<Order> Active => _orders.OfType<Order>().ToList();",
      "    public Task<Order> Get(int id) => _repo.Find<Order>(id);",
      "}",
    ].join("\n");
    const names = defs(extractTags("OrdersDbContext.cs", source)).map((t) => t.name);
    expect(names).toEqual(["OrdersDbContext", "Orders", "Active", "Get"]);
    for (const bodyCall of ["Set", "OfType", "Find"]) {
      expect(names).not.toContain(bodyCall);
    }
  });

  it("finds a member whose attribute list sits on the same line", () => {
    const source = [
      "public class OrdersController : ControllerBase",
      "{",
      "    [Key] public int Id { get; set; }",
      "    [JsonProperty(\"name\")] public string Name { get; set; }",
      "    [HttpGet(\"{id}\")] public async Task<IActionResult> Get(int id) => Ok();",
      "    [AllowAnonymous] public IActionResult Health() => Ok();",
      "    [Authorize(Roles = \"Admin\")] public IActionResult Admin() => Ok();",
      "    [Obsolete, Browsable(false)] public void Legacy() { }",
      "    public IActionResult Plain() => Ok();",
      "}",
    ].join("\n");
    const tags = extractTags("OrdersController.cs", source);
    expect(defs(tags).map((t) => t.name)).toEqual([
      "OrdersController", "Id", "Name", "Get", "Health", "Admin", "Legacy", "Plain",
    ]);
    // The def keeps the whole line, attribute included: the map is how a
    // question about `[Authorize]` sees which actions carry it.
    expect(defNamed(tags, "Health")!.signature).toContain("[AllowAnonymous]");
    // Stripping the list for the def match does not cost the attribute refs.
    for (const attribute of ["Key", "AllowAnonymous", "Authorize"]) {
      expect(refNames(tags)).toContain(`${attribute}Attribute`);
    }
  });

  it("skips a local function inside a method body", () => {
    const source = [
      "public class OrderService",
      "{",
      "    public void Process(OrderDto order)",
      "    {",
      "        static bool IsValid(OrderDto o) => o.Id > 0;",
      "        int Total(OrderDto o)",
      "        {",
      "            return o.Id;",
      "        }",
      "        if (IsValid(order)) Total(order);",
      "    }",
      "    public void After() { }",
      "}",
    ].join("\n");
    const names = defs(extractTags("OrderService.cs", source)).map((t) => t.name);
    expect(names).toEqual(["OrderService", "Process", "After"]);
  });

  it("keeps Allman braces, nested types and a file-scoped namespace straight", () => {
    const source = [
      "namespace Acme.Orders;",
      "",
      "public class Outer",
      "{",
      "    public class Inner",
      "    {",
      "        public void InnerMethod() { }",
      "    }",
      "    public void OuterMethod() { }",
      "}",
    ].join("\n");
    const names = defs(extractTags("Outer.cs", source)).map((t) => t.name);
    expect(names).toEqual(["Acme.Orders", "Outer", "Inner", "InnerMethod", "OuterMethod"]);
  });

  it("does not let a brace-less record hide the members that follow it", () => {
    const source = [
      "public class Container",
      "{",
      "    public record Point(int X, int Y);",
      "    public void UsePoint() { }",
      "}",
    ].join("\n");
    const names = defs(extractTags("Container.cs", source)).map((t) => t.name);
    expect(names).toEqual(["Container", "Point", "UsePoint"]);
  });
});

describe("C# references", () => {
  it("treats an attribute as a reference to its name and to its Attribute class", () => {
    const source = [
      "[ApiController]",
      "[Route(\"api/[controller]\")]",
      "public class OrdersController : ControllerBase",
      "{",
      "    [HttpGet(\"{id}\")]",
      "    [Authorize(Roles = \"Admin\"), AllowAnonymous]",
      "    public IActionResult Get(int id) => Ok();",
      "    [return: NotNull]",
      "    public OrderDto Build() => null;",
      "}",
    ].join("\n");
    const names = refNames(extractTags("OrdersController.cs", source));
    for (const attribute of ["ApiController", "Route", "HttpGet", "Authorize", "AllowAnonymous", "NotNull"]) {
      expect(names).toContain(attribute);
      expect(names).toContain(`${attribute}Attribute`);
    }
    // The string arguments are masked: a route template is not a symbol.
    expect(names).not.toContain("api");
    expect(names).not.toContain("controller");
  });

  it("treats a DI registration as a reference to both type arguments", () => {
    const source = [
      "var builder = WebApplication.CreateBuilder(args);",
      "builder.Services.AddScoped<IOrderRepository, OrderRepository>();",
      "builder.Services.AddTransient<IOrderService, OrderService>();",
      "builder.Services.AddSingleton<IClock, SystemClock>();",
      "builder.Services.AddHostedService<OrderSyncWorker>();",
    ].join("\n");
    const names = refNames(extractTags("Program.cs", source));
    for (const type of [
      "IOrderRepository", "OrderRepository", "IOrderService", "OrderService",
      "IClock", "SystemClock", "OrderSyncWorker",
    ]) {
      expect(names).toContain(type);
    }
  });

  it("links a using directive to the namespace it names", () => {
    const tags = [
      ...extractTags("Services/OrderService.cs", "namespace Acme.Orders.Services;\npublic class OrderService { }"),
      ...extractTags("Api/OrdersController.cs", "using Acme.Orders.Services;\npublic class OrdersController { }"),
    ];
    const namespaceDef = defNamed(tags, "Acme.Orders.Services");
    const usingRef = refs(tags).find((t) => t.name === "Acme.Orders.Services");
    expect(namespaceDef?.path).toBe("Services/OrderService.cs");
    expect(usingRef?.path).toBe("Api/OrdersController.cs");
  });

  it("does not count keywords or BCL noise as references", () => {
    const source = [
      "public async Task<List<OrderDto>> Load(CancellationToken token)",
      "{",
      "    var items = new List<OrderDto>();",
      "    foreach (var item in items) { await Task.Delay(1, token); }",
      "    return items ?? throw new InvalidOperationException();",
      "}",
    ].join("\n");
    const names = refNames(extractTags("Loader.cs", source));
    for (const keyword of ["public", "async", "var", "new", "foreach", "await", "return", "throw", "null"]) {
      expect(names).not.toContain(keyword);
    }
    for (const noise of ["Task", "List"]) {
      expect(names).not.toContain(noise);
    }
    expect(names).toContain("OrderDto");
    expect(names).toContain("CancellationToken");
  });
});

describe("C# comments and strings", () => {
  it("does not find a def inside a line comment, a doc comment, a block comment or a directive", () => {
    const source = [
      "// public class CommentedOut { }",
      "/// <summary>Returns an <see cref=\"OrderDto\"/>. class DocComment</summary>",
      "/* public class Blocked { }",
      "   public void StillBlocked() { } */",
      "#region public class Region",
      "public class Real",
      "{",
      "    public void Method() { } // public void Trailing() { }",
      "}",
      "#endregion",
    ].join("\n");
    const tags = extractTags("Real.cs", source);
    expect(defs(tags).map((t) => t.name)).toEqual(["Real", "Method"]);
    expect(refNames(tags)).not.toContain("CommentedOut");
    expect(refNames(tags)).not.toContain("DocComment");
    expect(refNames(tags)).not.toContain("Region");
  });

  it("does not find a def inside a regular, verbatim, interpolated or raw string", () => {
    const source = [
      "public class Strings",
      "{",
      "    string a = \"public class InRegular { }\";",
      "    string b = @\"public class InVerbatim \"\" { }\";",
      "    string c = $\"public class InInterpolated {a} {{ }}\";",
      "    string d = \"\"\"",
      "        public class InRaw { }",
      "        \"\"\";",
      "    char e = '\"';",
      "    public void After() { }",
      "}",
    ].join("\n");
    const tags = extractTags("Strings.cs", source);
    expect(defs(tags).map((t) => t.name)).toEqual(["Strings", "After"]);
    for (const hidden of ["InRegular", "InVerbatim", "InInterpolated", "InRaw"]) {
      expect(refNames(tags)).not.toContain(hidden);
    }
  });

  it("does not let an interpolated raw string swallow the defs after it", () => {
    // `$"""` begins with `$"`, which the regular-string branch used to claim:
    // an empty string, then a quote left open to the end of the line, then the
    // closing `"""` read as an opener that blanked the rest of the file.
    const source = [
      "public class Payloads",
      "{",
      "    public string Interpolated(int id) => $\"\"\"",
      "        {\"id\": {id}}",
      "        \"\"\";",
      "    public void AfterInterpolated() { }",
      "    public string Doubled(int id) => $$\"\"\"",
      "        {\"id\": {{id}}}",
      "        \"\"\";",
      "    public void AfterDoubled() { }",
      "}",
      "public class Next { }",
    ].join("\n");
    const tags = extractTags("Payloads.cs", source);
    expect(defs(tags).map((t) => t.name)).toEqual([
      "Payloads", "Interpolated", "AfterInterpolated", "Doubled", "AfterDoubled", "Next",
    ]);
    // The literal's body is masked like any other string: `id` in a JSON key
    // is not a symbol.
    expect(refs(tags).some((t) => t.line === 4 || t.line === 8)).toBe(false);
  });

  it("does not let a char literal holding a quote swallow the rest of the file", () => {
    const source = [
      "public class Chars",
      "{",
      "    char q = '\"';",
      "    char e = '\\'';",
      "    public void Visible() { }",
      "}",
    ].join("\n");
    expect(defs(extractTags("Chars.cs", source)).map((t) => t.name)).toEqual(["Chars", "Visible"]);
  });
});

describe("C# file shapes", () => {
  it("yields a def per file for a partial class split across two files", () => {
    const tags = [
      ...extractTags("Orders/OrderService.cs", "public partial class OrderService { public void Save() { } }"),
      ...extractTags("Orders/OrderService.Queries.cs", "public partial class OrderService { public void Find() { } }"),
    ];
    const classDefs = defs(tags).filter((t) => t.name === "OrderService");
    expect(classDefs.map((t) => t.path).sort()).toEqual([
      "Orders/OrderService.Queries.cs",
      "Orders/OrderService.cs",
    ]);
  });

  it("parses a file with a BOM and CRLF line endings, citing editor line numbers", () => {
    const source = "﻿using Acme.Orders;\r\n\r\npublic class OrderService\r\n{\r\n    public void Save() { }\r\n}\r\n";
    expect(source.charCodeAt(0)).toBe(0xfeff);
    const tags = extractTags("OrderService.cs", source);
    expect(defNamed(tags, "OrderService")?.line).toBe(3);
    expect(defNamed(tags, "Save")?.line).toBe(5);
    expect(defNamed(tags, "OrderService")?.signature).toBe("public class OrderService");
    // The `using` is anchored at the start of line 1, which is exactly where
    // the BOM sits; the directive ref proves the anchor still lands.
    expect(refs(tags).find((t) => t.name === "Acme.Orders")?.line).toBe(1);
  });

  it("does not turn `using System;` into a reference that would seed every file", () => {
    const tags = extractTags("Any.cs", "using System;\nusing System.Linq;\nusing Acme.Orders;\n");
    const names = refs(tags).map((t) => t.name);
    expect(names).not.toContain("System");
    expect(names).not.toContain("System.Linq");
    expect(names).toContain("Acme.Orders");
  });

  it("contributes nothing for a language it does not know", () => {
    expect(extractTags("Program.fs", "type OrderService() = class end")).toEqual([]);
  });
});

describe("C# ranking, end to end", () => {
  it("ranks a controller reached through a DI registration above an unreferenced helper", () => {
    const tags = [
      ...extractTags(
        "Api/OrdersController.cs",
        [
          "[ApiController]",
          "public class OrdersController : ControllerBase",
          "{",
          "    public OrdersController(IOrderService orders) { }",
          "}",
        ].join("\n"),
      ),
      ...extractTags(
        "Services/IOrderService.cs",
        "public interface IOrderService { }",
      ),
      ...extractTags(
        "Services/OrderService.cs",
        "public class OrderService : IOrderService { }",
      ),
      ...extractTags(
        "Program.cs",
        [
          "builder.Services.AddScoped<IOrderService, OrderService>();",
          "builder.Services.AddControllers().AddApplicationPart(typeof(OrdersController).Assembly);",
        ].join("\n"),
      ),
      ...extractTags(
        "Util/StringHelper.cs",
        "public static class StringHelper { public static string Trim(string s) => s; }",
      ),
    ];
    const ranked = rankFiles({ tags, seeds: [] });
    const rankOf = (path: string) => ranked.findIndex((r) => r.path === path);
    expect(rankOf("Api/OrdersController.cs")).toBeLessThan(rankOf("Util/StringHelper.cs"));
    expect(rankOf("Services/OrderService.cs")).toBeLessThan(rankOf("Util/StringHelper.cs"));
  });
});

describe("C# minimal-hosting Program.cs", () => {
  const program = [
    "var builder = WebApplication.CreateBuilder(args);",
    "builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)",
    "    .AddJwtBearer(o => { o.Authority = cfg.Authority; });",
    "builder.Services.AddAuthorization(o => o.AddPolicy(\"Admin\", p => p.RequireRole(\"Admin\")));",
    "builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin()));",
    "builder.Services.AddScoped<IOrderRepository, OrderRepository>();",
    "var app = builder.Build();",
    "app.UseCors();",
    "app.UseAuthorization();",
    "app.UseAuthentication();",
    "app.UseMiddleware<TenantMiddleware>();",
    "app.MapGet(\"/health\", () => Results.Ok()).AllowAnonymous();",
    "app.MapPost(\"/orders\", (OrderDto dto, IOrderService svc) => svc.Create(dto));",
    "app.MapGroup(\"/admin\").RequireAuthorization(\"Admin\");",
    "app.Run();",
  ].join("\n");

  it("treats each host-shaping statement as a def named by its method, and nothing else", () => {
    const tags = extractTags("Program.cs", program);
    expect(defs(tags).map((t) => t.name)).toEqual([
      "AddAuthentication", "AddAuthorization", "AddCors", "AddScoped",
      "UseCors", "UseAuthorization", "UseAuthentication", "UseMiddleware",
      "MapGet", "MapPost", "MapGroup",
    ]);
    // The signature is the statement itself: the middleware order and the
    // CORS policy are only visible if the map shows the line, not the name.
    expect(defNamed(tags, "UseAuthorization")!.signature).toBe("app.UseAuthorization();");
    expect(defNamed(tags, "AddCors")!.signature).toContain("AllowAnyOrigin");
  });

  it("reaches the rendered map, which drops files with no defs", () => {
    const tags = [
      ...extractTags("Program.cs", program),
      ...extractTags("Services/OrderRepository.cs", "public class OrderRepository : IOrderRepository { }"),
    ];
    const ranked = rankFiles({ tags, seeds: [] });
    const rendered = renderRepoMap({ ranked, tags, diffTokens: 0 });
    expect(rendered.text).toContain("Program.cs:");
    expect(rendered.text).toContain("app.UseAuthorization();");
  });

  it("does not turn the same calls inside a classic Startup class into defs", () => {
    // Inside a type body the calls already sit under a method def; a second
    // def per line would list ConfigureServices a dozen times.
    const source = [
      "public class Startup",
      "{",
      "    public void ConfigureServices(IServiceCollection services)",
      "    {",
      "        services.AddAuthorization();",
      "        services.AddScoped<IOrderRepository, OrderRepository>();",
      "    }",
      "    public void Configure(IApplicationBuilder app)",
      "    {",
      "        app.UseAuthorization();",
      "    }",
      "}",
    ].join("\n");
    const names = defs(extractTags("Startup.cs", source)).map((t) => t.name);
    expect(names).toEqual(["Startup", "ConfigureServices", "Configure"]);
  });
});

describe("TS/JS extraction is untouched by the C# backend", () => {
  it("produces exactly the tags it did before, for the same input", () => {
    const source = [
      "import { mask } from './mask';",
      "export function redact(x: string) {",
      "  return mask(x);",
      "}",
      "export const DEFAULT = 'a';",
    ].join("\n");
    const tag = (name: string, kind: "def" | "ref", line: number, signature = ""): Tag => ({
      path: "src/redact.ts", name, kind, line, signature,
    });
    expect(extractTags("src/redact.ts", source)).toEqual([
      tag("redact", "def", 2, "export function redact(x: string) {"),
      tag("DEFAULT", "def", 5, "export const DEFAULT = 'a';"),
      tag("mask", "ref", 1),
      tag("mask", "ref", 1),
      tag("redact", "ref", 2),
      tag("string", "ref", 2),
      tag("mask", "ref", 3),
      tag("DEFAULT", "ref", 5),
    ]);
  });
});
