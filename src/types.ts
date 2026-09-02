export const SCHEMA_VERSION = 11;

export const INLINE_LIMIT = 1200;

export const KINDS = ["decision", "fact", "procedure", "context", "research", "preference", "task"] as const;
export type Kind = (typeof KINDS)[number];

export const PREDICATES = ["SUPPORTS", "DERIVED_FROM", "PART_OF", "ABOUT", "PRECEDES", "SUPERSEDES"] as const;
export type Predicate = (typeof PREDICATES)[number];

export type SizeClass = "inline" | "indexed";

export interface Project {
  projectID: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends Project {
  noteCount: number;
  pinnedCount: number;
}

export interface Note {
  id: string;
  projectID: string;
  projectName: string;
  kind: Kind;
  title: string;
  summary: string;
  content: string;
  sizeClass: SizeClass;
  pinned: boolean;
  status: "active" | "superseded" | "archived";
  supersedesID: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Edge {
  id: string;
  projectID: string;
  projectName: string;
  sourceID: string;
  targetID: string;
  predicate: Predicate;
  createdAt: number;
}

export interface RecallCard {
  id: string;
  projectID: string;
  projectName: string;
  kind: Kind;
  title: string;
  summary: string;
  content?: string;
  sizeClass: SizeClass;
  pinned: boolean;
  via: "match" | "neighbor";
  predicates?: string[];
}
