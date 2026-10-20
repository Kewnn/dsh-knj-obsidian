import type { VaultStore } from './vault-store.ts';
import type { WikiCategory, Confidence } from './types.ts';
export interface GraphNode {
    id: string;
    title: string;
    category: WikiCategory;
    confidence: Confidence;
}
export interface GraphEdge {
    source: string;
    target: string;
    broken: boolean;
}
export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
    orphanIds: string[];
    pageCount: number;
}
export declare function buildGraph(store: VaultStore): GraphData;
/**
 * 导出单文件交互图谱 HTML：内联 SVG + 原生 JS 力导向布局（斥力 + 弹簧力，多帧收敛），
 * 支持拖拽节点、滚轮缩放（viewBox）、悬停显示标题、按 category 着色、断链红色虚线、孤儿灰色。
 * 零外部依赖。所有用户内容（title/id）经 jsonForEmbed 转义，渲染层用 textContent，双保险防注入。
 */
export declare function exportGraphHtml(graph: GraphData): string;
