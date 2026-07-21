export const CREATE_DRAFT_TOOL = "create_draft" as const;
export const CREATE_DRAFT_SDK_TOOL = "mcp__socialite__create_draft" as const;
export const CAPTION_MAX = 2200;

export interface CreateDraftToolInput {
  caption: string;
  image_url: string;
}

export interface CreateDraftToolResult {
  draft_id: string;
  status: "draft";
  message: string;
}
