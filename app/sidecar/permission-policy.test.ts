import { describe, expect, it } from "vitest";
import {
  decideToolPermission,
  permissionGrantKey,
  type ToolPermissionCall,
} from "./permission-policy";
import { CREATE_DRAFT_SDK_TOOL, CREATE_DRAFT_TOOL } from "./app-tool-contract";

const workspace = "/app-data/projects/summer-launch";

function decide(call: ToolPermissionCall, grants: string[] = []) {
  return decideToolPermission(call, workspace, grants);
}

describe("tool permission policy", () => {
  it.each([CREATE_DRAFT_TOOL, CREATE_DRAFT_SDK_TOOL])(
    "automatically allows reversible local %s actions",
    (toolName) => {
      expect(
        decide({
          toolName,
          input: {
            caption: "A trail worth taking.",
            image_url: "https://images.example/trail.jpg",
          },
        }),
      ).toMatchObject({ decision: "allow", grantable: false });
    },
  );

  it.each([
    ["Read", { file_path: `${workspace}/CLAUDE.md` }],
    ["Write", { file_path: `${workspace}/drafts/post-one.md`, content: "Draft" }],
    ["Edit", { file_path: `${workspace}/captions/launch.md`, old_string: "a", new_string: "b" }],
    ["Glob", { path: workspace, pattern: "references/**/*.md" }],
    ["Grep", { path: `${workspace}/references`, pattern: "voice" }],
  ])("automatically allows in-workspace %s operations", (toolName, input) => {
    expect(decide({ toolName, input })).toMatchObject({
      decision: "allow",
      grantable: false,
    });
  });

  it("normalizes harmless segments but rejects traversal and sibling-prefix paths", () => {
    expect(
      decide({
        toolName: "Write",
        input: { file_path: `${workspace}/drafts/../caption.md`, content: "Safe" },
      }).decision,
    ).toBe("allow");

    for (const filePath of [
      `${workspace}/../other-project/caption.md`,
      `${workspace}-archive/caption.md`,
    ]) {
      expect(
        decide({ toolName: "Read", input: { file_path: filePath } }),
      ).toMatchObject({ decision: "prompt", grantable: false });
    }
  });

  it("rejects relative Glob patterns that traverse outside the workspace", () => {
    expect(
      decide({ toolName: "Glob", input: { pattern: "../other-project/**/*.md" } }),
    ).toMatchObject({ decision: "prompt", grantable: false });
  });

  it("always prompts for outside file and shell operations despite matching grants", () => {
    const outsideRead: ToolPermissionCall = {
      toolName: "Read",
      input: { file_path: "/Users/example/.ssh/config" },
    };
    const outsideShell: ToolPermissionCall = {
      toolName: "Bash",
      input: { command: "cat /Users/example/.ssh/config" },
    };

    for (const call of [outsideRead, outsideShell]) {
      expect(decide(call, [permissionGrantKey(call)])).toMatchObject({
        decision: "prompt",
        grantable: false,
      });
    }
  });

  it("does not offer standing grants for destructive shell commands", () => {
    const call = { toolName: "Bash", input: { command: "rm -rf ." } };

    expect(decide(call, [permissionGrantKey(call)])).toMatchObject({
      decision: "prompt",
      grantable: false,
    });
  });

  it("treats an SDK-resolved outside path as unsilenceable", () => {
    const call: ToolPermissionCall = {
      toolName: "Read",
      input: { file_path: `${workspace}/references/linked-secret` },
      blockedPath: "/Users/example/.ssh/config",
    };

    expect(decide(call, [permissionGrantKey(call)])).toMatchObject({
      decision: "prompt",
      grantable: false,
    });
  });

  it("never silences publish_now, even with an exact standing grant", () => {
    const call = { toolName: "publish_now", input: { postId: "post-1" } };

    expect(decide(call, [permissionGrantKey(call)])).toMatchObject({
      decision: "prompt",
      grantable: false,
    });
  });

  it("isolates a standing grant to the exact safe tool and arguments", () => {
    const allowed = { toolName: "Bash", input: { command: "git status --short" } };
    const grants = [permissionGrantKey(allowed)];

    expect(decide(allowed, grants).decision).toBe("allow");
    expect(
      decide({ toolName: "Bash", input: { command: "git status" } }, grants).decision,
    ).toBe("prompt");
    expect(
      decide({ toolName: "Read", input: { file_path: "/tmp/status" } }, grants),
    ).toMatchObject({ decision: "prompt", grantable: false });
  });

  it("denies malformed file requests and unsupported tools", () => {
    expect(decide({ toolName: "Write", input: { content: "No path" } }).decision).toBe(
      "deny",
    );
    expect(decide({ toolName: "WebFetch", input: { url: "https://example.com" } }).decision).toBe(
      "deny",
    );
  });
});
