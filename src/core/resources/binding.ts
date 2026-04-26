export type ResourceSource = "bundled" | "mcp" | "project" | "http";

export interface ResourceBinding {
  readonly id: string;
  readonly source: ResourceSource;
  readonly uri: string;
  readonly byteCap: number;
  readonly tokenCap: number;
}
