import { create } from 'zustand';
import type { JobEdge, JobNode, JobNodeConfig, JobNodeMode, JobOnFailure, JobStepType } from '../../../types.js';
import {
  DEFAULT_SCHEDULE, newNodeKey, toBody,
  type JobBody, type JobDraft, type ScheduleForm,
} from '../lib/api.js';
import { autoLayout, needsAutoLayout, wouldCreateCycle } from '../lib/graph.js';
import { JOB_NODE_META } from '../lib/nodeMeta.js';

interface Snapshot {
  name: string;
  description: string;
  nodes: JobNode[];
  edges: JobEdge[];
  schedule: ScheduleForm;
}

interface Draft {
  name: string;
  description: string;
  nodes: JobNode[];
  edges: JobEdge[];
  schedule: ScheduleForm;
}

export interface JobEditorState extends Draft {
  selectedKey: string | null;
  dirty: boolean;
  past: Snapshot[];
  future: Snapshot[];

  load(draft: JobDraft): void;
  markSaved(): void;
  /** 一次性写入 Job 级设置（名称/描述/调度），作为一个撤销步骤。 */
  setJobMeta(meta: { name: string; description: string; schedule: ScheduleForm }): void;
  addNode(type: JobStepType, position?: { x: number; y: number }): string;
  updateNode(
    key: string,
    patch: { name?: string; onFailure?: JobOnFailure; mode?: JobNodeMode; config?: JobNodeConfig },
  ): void;
  removeNodes(keys: string[]): void;
  addEdge(source: string, target: string): { ok: true } | { ok: false; reason: string };
  removeEdges(pairs: JobEdge[]): void;
  select(key: string | null): void;
  copyNode(key: string): boolean;
  pasteNode(): string | null;
  duplicateNode(key: string): string | null;
  beginDrag(): void;
  moveNodes(map: Record<string, { x: number; y: number }>): void;
  endDrag(): void;
  autoLayout(): void;
  undo(): void;
  redo(): void;
  endMerge(): void;
  toBody(): JobBody;
}

const MAX_HISTORY = 50;
const MERGE_WINDOW_MS = 700;

/** 同类轻量变更（拖动、输入）在窗口内合并为一步撤销。 */
let lastMerge: { tag: string; at: number } | null = null;
/** 拖动开始时的快照，拖动结束才入历史。 */
let dragBase: Snapshot | null = null;
/** 节点剪贴板：⌘C 存入，⌘V 带偏移粘贴。 */
let clipboard: {
  type: JobStepType;
  name: string;
  onFailure: JobOnFailure;
  mode: JobNodeMode;
  config: JobNodeConfig;
  x: number;
  y: number;
} | null = null;

const cloneNodes = (nodes: JobNode[]): JobNode[] =>
  nodes.map((n) => ({ ...n, config: { ...n.config } }));

function snapshotOf(state: Draft): Snapshot {
  return {
    name: state.name,
    description: state.description,
    nodes: cloneNodes(state.nodes),
    edges: state.edges.map((e) => ({ ...e })),
    schedule: { ...state.schedule },
  };
}

const samePositions = (a: JobNode[], b: JobNode[]): boolean =>
  a.length === b.length &&
  a.every((node) => {
    const other = b.find((n) => n.key === node.key);
    return other !== undefined && other.x === node.x && other.y === node.y;
  });

function defaultConfig(type: JobStepType): JobNodeConfig {
  if (type === 'workflow') return { workflowId: '' };
  if (type === 'sql') return { connectionId: '', sql: '' };
  return { source: 'file', modelName: '', resourcePath: '' };
}

export const useJobEditorStore = create<JobEditorState>((set, get) => {
  /** 所有图变更统一入口：变更前压快照，tag 相同且在窗口内则合并。 */
  function commit(
    tag: string | null,
    mutate: (draft: Draft) => void,
    extra: Partial<JobEditorState> = {},
  ): void {
    const state = get();
    const now = Date.now();
    const merge = tag !== null && lastMerge?.tag === tag && now - lastMerge.at < MERGE_WINDOW_MS;
    const draft: Draft = {
      name: state.name,
      description: state.description,
      nodes: state.nodes,
      edges: state.edges,
      schedule: state.schedule,
    };
    mutate(draft);
    set({
      ...draft,
      dirty: true,
      ...(merge ? {} : { past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY), future: [] }),
      ...extra,
    });
    lastMerge = tag ? { tag, at: now } : null;
  }

  /** 复制节点（右键复制 / ⌘V 粘贴共用），一次 commit 只入一步历史。 */
  function insertCopy(source: {
    type: JobStepType;
    name: string;
    onFailure: JobOnFailure;
    mode: JobNodeMode;
    config: JobNodeConfig;
    x: number;
    y: number;
  }): string {
    const state = get();
    const key = newNodeKey(state.nodes.map((n) => n.key));
    commit(null, (draft) => {
      draft.nodes = [
        ...draft.nodes,
        {
          key,
          seq: draft.nodes.length,
          type: source.type,
          name: source.name,
          onFailure: source.onFailure,
          mode: source.mode,
          x: Math.round(source.x),
          y: Math.round(source.y),
          config: { ...source.config },
        },
      ];
    }, { selectedKey: key });
    return key;
  }

  return {
    name: '',
    description: '',
    nodes: [],
    edges: [],
    schedule: DEFAULT_SCHEDULE,
    selectedKey: null,
    dirty: false,
    past: [],
    future: [],

    load(draft) {
      const nodes = needsAutoLayout(draft.nodes)
        ? applyLayout(cloneNodes(draft.nodes), draft.edges)
        : cloneNodes(draft.nodes);
      lastMerge = null;
      dragBase = null;
      set({
        name: draft.name,
        description: draft.description,
        nodes,
        edges: draft.edges.map((e) => ({ ...e })),
        schedule: { ...draft.schedule },
        selectedKey: null,
        dirty: false,
        past: [],
        future: [],
      });
    },

    markSaved() {
      set({ dirty: false, past: [], future: [] });
      lastMerge = null;
    },

    setJobMeta(meta) {
      const state = get();
      const unchanged =
        state.name === meta.name &&
        state.description === meta.description &&
        JSON.stringify(state.schedule) === JSON.stringify(meta.schedule);
      if (unchanged) return;
      commit(null, (draft) => {
        draft.name = meta.name;
        draft.description = meta.description;
        draft.schedule = meta.schedule;
      });
    },

    addNode(type, position) {
      const state = get();
      const key = newNodeKey(state.nodes.map((n) => n.key));
      const stagger = state.nodes.length;
      const pos = position ?? { x: 120 + (stagger % 6) * 48, y: 120 + (stagger % 6) * 48 };
      commit(null, (draft) => {
        draft.nodes = [
          ...draft.nodes,
          {
            key,
            seq: draft.nodes.length,
            type,
            name: JOB_NODE_META[type].defaultName,
            onFailure: 'abort',
            mode: 'run',
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            config: defaultConfig(type),
          },
        ];
      }, { selectedKey: key });
      return key;
    },

    updateNode(key, patch) {
      const tag = patch.name !== undefined ? `name:${key}` : patch.config !== undefined ? `config:${key}` : null;
      commit(tag, (draft) => {
        draft.nodes = draft.nodes.map((node) =>
          node.key === key
            ? {
                ...node,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.onFailure !== undefined ? { onFailure: patch.onFailure } : {}),
                ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
                ...(patch.config !== undefined ? { config: { ...node.config, ...patch.config } } : {}),
              }
            : node,
        );
      });
    },

    removeNodes(keys) {
      const removed = new Set(keys);
      if (removed.size === 0) return;
      commit(null, (draft) => {
        draft.nodes = draft.nodes.filter((n) => !removed.has(n.key));
        draft.edges = draft.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
      }, {
        selectedKey: get().selectedKey && removed.has(get().selectedKey!) ? null : get().selectedKey,
      });
    },

    addEdge(source, target) {
      const check = wouldCreateCycle(get().edges, source, target);
      if (!check.ok) return check;
      commit(null, (draft) => {
        draft.edges = [...draft.edges, { source, target }];
      });
      return { ok: true };
    },

    removeEdges(pairs) {
      if (pairs.length === 0) return;
      const keys = new Set(pairs.map((p) => `${p.source}\u0000${p.target}`));
      commit(null, (draft) => {
        draft.edges = draft.edges.filter((e) => !keys.has(`${e.source}\u0000${e.target}`));
      });
    },

    select(key) {
      set({ selectedKey: key });
    },

    copyNode(key) {
      const node = get().nodes.find((n) => n.key === key);
      if (!node) return false;
      clipboard = {
        type: node.type,
        name: node.name,
        onFailure: node.onFailure,
        mode: node.mode,
        config: { ...node.config },
        x: node.x,
        y: node.y,
      };
      return true;
    },

    pasteNode() {
      if (!clipboard) return null;
      const source = clipboard;
      const key = insertCopy(source);
      clipboard = { ...source, x: source.x + 40, y: source.y + 40 };
      return key;
    },

    duplicateNode(key) {
      const node = get().nodes.find((n) => n.key === key);
      if (!node) return null;
      return insertCopy({ ...node, config: { ...node.config }, x: node.x + 40, y: node.y + 40 });
    },

    beginDrag() {
      dragBase = snapshotOf(get());
      lastMerge = null;
    },

    moveNodes(map) {
      const entries = Object.entries(map);
      if (entries.length === 0) return;
      const positions = new Map(entries);
      set({
        nodes: get().nodes.map((node) => {
          const pos = positions.get(node.key);
          return pos ? { ...node, x: Math.round(pos.x), y: Math.round(pos.y) } : node;
        }),
        dirty: true,
      });
    },

    endDrag() {
      const base = dragBase;
      dragBase = null;
      if (!base) return;
      const state = get();
      if (samePositions(base.nodes, state.nodes)) return;
      set({ past: [...state.past, base].slice(-MAX_HISTORY), future: [] });
    },

    autoLayout() {
      commit(null, (draft) => {
        draft.nodes = applyLayout(draft.nodes, draft.edges);
      });
    },

    undo() {
      const state = get();
      const prev = state.past[state.past.length - 1];
      if (!prev) return;
      lastMerge = null;
      set({
        ...prev,
        nodes: cloneNodes(prev.nodes),
        edges: prev.edges.map((e) => ({ ...e })),
        schedule: { ...prev.schedule },
        past: state.past.slice(0, -1),
        future: [...state.future, snapshotOf(state)].slice(-MAX_HISTORY),
        dirty: true,
        selectedKey: prev.nodes.some((n) => n.key === state.selectedKey) ? state.selectedKey : null,
      });
    },

    redo() {
      const state = get();
      const next = state.future[state.future.length - 1];
      if (!next) return;
      lastMerge = null;
      set({
        ...next,
        nodes: cloneNodes(next.nodes),
        edges: next.edges.map((e) => ({ ...e })),
        schedule: { ...next.schedule },
        future: state.future.slice(0, -1),
        past: [...state.past, snapshotOf(state)].slice(-MAX_HISTORY),
        dirty: true,
        selectedKey: next.nodes.some((n) => n.key === state.selectedKey) ? state.selectedKey : null,
      });
    },

    endMerge() {
      lastMerge = null;
    },

    toBody() {
      const state = get();
      return toBody({
        name: state.name,
        description: state.description,
        nodes: state.nodes,
        edges: state.edges,
        schedule: state.schedule,
      });
    },
  };
});

function applyLayout(nodes: JobNode[], edges: JobEdge[]): JobNode[] {
  const layout = autoLayout(nodes, edges);
  return nodes.map((node) => {
    const pos = layout.get(node.key);
    return pos ? { ...node, x: pos.x, y: pos.y } : node;
  });
}
