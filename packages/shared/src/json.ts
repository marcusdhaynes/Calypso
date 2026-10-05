export interface ToolPropertySchema {
  type: "string" | "integer";
  description: string;
}

export interface ToolParameters {
  type: "object";
  additionalProperties: false;
  required: readonly string[];
  properties: Readonly<Record<string, ToolPropertySchema>>;
}
