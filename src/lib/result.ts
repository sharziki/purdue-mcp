export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}
