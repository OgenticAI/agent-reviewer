#!/usr/bin/env tsx
/**
 * One-time setup: ensures the team OGE workflow has a "Ready to Merge"
 * status (started type) so OGE-339's status writeback has a target to
 * transition to.
 *
 * Run once after registering a fresh OgenticAI workspace, or whenever a new
 * Linear team is added that the reviewer should write back to:
 *
 *   LINEAR_API_TOKEN=lin_api_xxx tsx scripts/install-linear-statuses.ts --team OGE
 *
 * Idempotent: if "Ready to Merge" already exists with type=started, exits
 * cleanly. If a status with the same name exists in a different group
 * (e.g. completed), prints a warning and exits 1 — those need a human.
 *
 * The script is safe to commit and re-run; it never mutates statuses that
 * already have the right shape.
 */

import { LinearGraphqlClient } from "../src/linear/client.js";

interface Args {
  team: string;
  statusName: string;
  /** position in the workflow column ordering. Linear's UI shows by position. */
  position: number;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const teamIdx = args.indexOf("--team");
  const team = teamIdx >= 0 ? args[teamIdx + 1] : "OGE";
  const nameIdx = args.indexOf("--name");
  const statusName = nameIdx >= 0 ? args[nameIdx + 1]! : "Ready to Merge";
  const posIdx = args.indexOf("--position");
  const position = posIdx >= 0 ? Number(args[posIdx + 1]) : 25;
  return { team: team!, statusName, position };
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.LINEAR_API_TOKEN;
  if (!token) {
    console.error("LINEAR_API_TOKEN env var required");
    process.exit(1);
  }

  // We need the team ID, not the key — but the GraphQL `team(id:)` accepts
  // either. Fall through to a lookup-by-key if the user passed a key.
  const teamId = await resolveTeamId(token, args.team);

  // Check for existing status with the same name on this team.
  const existing = await listStatuses(token, teamId);
  const match = existing.find((s) => s.name.toLowerCase() === args.statusName.toLowerCase());
  if (match) {
    if (match.type === "started") {
      console.error(`[ok] "${args.statusName}" already exists on team ${args.team} (type=${match.type})`);
      return;
    }
    console.error(
      `[warn] "${args.statusName}" exists on team ${args.team} but has type="${match.type}" — expected "started". ` +
        `Edit the workflow in Linear's UI or remove the conflicting status.`,
    );
    process.exit(1);
  }

  // Create the new state. Color #10B981 (emerald) to match Linear's "ready" idiom.
  await createState(token, {
    teamId,
    name: args.statusName,
    type: "started",
    color: "#10B981",
    position: args.position,
  });
  console.error(`[created] "${args.statusName}" on team ${args.team}`);
}

async function resolveTeamId(token: string, teamRef: string): Promise<string> {
  // If teamRef already looks like a UUID, use it.
  if (/^[0-9a-f-]{36}$/i.test(teamRef)) return teamRef;

  // Otherwise look up by key.
  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      query: `query { teams(first: 50) { nodes { id key } } }`,
    }),
  });
  const json = (await resp.json()) as {
    data: { teams: { nodes: Array<{ id: string; key: string }> } };
  };
  const team = json.data.teams.nodes.find((t) => t.key === teamRef);
  if (!team) {
    throw new Error(`Linear team "${teamRef}" not found`);
  }
  return team.id;
}

async function listStatuses(token: string, teamId: string) {
  const client = new LinearGraphqlClient({ token });
  return client.listTeamStatuses(teamId);
}

async function createState(
  token: string,
  args: { teamId: string; name: string; type: string; color: string; position: number },
): Promise<void> {
  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      query: `mutation($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) { success state { id name } }
      }`,
      variables: {
        input: {
          teamId: args.teamId,
          name: args.name,
          type: args.type,
          color: args.color,
          position: args.position,
        },
      },
    }),
  });
  const json = (await resp.json()) as {
    data?: { workflowStateCreate: { success: boolean } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data?.workflowStateCreate.success) {
    throw new Error("workflowStateCreate failed (no error message)");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
