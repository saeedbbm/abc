"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import dynamic from "next/dynamic";

const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

interface GraphNode {
  node_id: string;
  type: string;
  display_name: string;
  confidence: string;
}

interface GraphEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
}

interface FGNode {
  id: string;
  name: string;
  type: string;
  confidence: string;
  color: string;
  val: number;
}

interface FGLink {
  source: string;
  target: string;
  edgeType: string;
}

const TYPE_COLORS: Record<string, string> = {
  team_member: "#3b82f6",
  team: "#8b5cf6",
  client_company: "#ec4899",
  client_person: "#10b981",
  repository: "#10b981",
  integration: "#a855f7",
  infrastructure: "#14b8a6",
  cloud_resource: "#0ea5e9",
  library: "#84cc16",
  database: "#f59e0b",
  environment: "#f97316",
  project: "#06b6d4",
  ticket: "#ef4444",
  pull_request: "#7c3aed",
  pipeline: "#eab308",
  customer_feedback: "#f472b6",
};

export function KB2GraphExplorer({
  companySlug,
  runId,
}: {
  companySlug: string;
  runId: string | null;
}) {
  const fgRef = useRef<any>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [filterType, setFilterType] = useState<string>("all");

  const fetchGraph = useCallback(async () => {
    const runParam = runId ? `&run_id=${runId}` : "";
    const [nodesRes, edgesRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=graph_nodes${runParam}`),
      fetch(`/api/${companySlug}/kb2?type=graph_edges${runParam}`),
    ]);
    const nodesData = await nodesRes.json();
    const edgesData = await edgesRes.json();
    setNodes(nodesData.nodes || []);
    setEdges(edgesData.edges || []);
  }, [companySlug, runId]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const filteredNodes = filterType === "all" ? nodes : nodes.filter((n) => n.type === filterType);
  const filteredIds = new Set(filteredNodes.map((n) => n.node_id));
  const filteredEdges = edges.filter(
    (e) => filteredIds.has(e.source_node_id) && filteredIds.has(e.target_node_id),
  );

  const graphData = {
    nodes: filteredNodes.map((n): FGNode => ({
      id: n.node_id,
      name: n.display_name,
      type: n.type,
      confidence: n.confidence,
      color: TYPE_COLORS[n.type] || "#888",
      val: n.type === "team_member" || n.type === "repository" ? 4 : 2,
    })),
    links: filteredEdges.map((e): FGLink => ({
      source: e.source_node_id,
      target: e.target_node_id,
      edgeType: e.type,
    })),
  };

  const nodeTypes = [...new Set(nodes.map((n) => n.type))].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium">Filter by type:</span>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-48 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ({nodes.length})</SelectItem>
            {nodeTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {t} ({nodes.filter((n) => n.type === t).length})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-2 flex-wrap">
          {nodeTypes.map((t) => (
            <div key={t} className="flex items-center gap-1 text-[10px]">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: TYPE_COLORS[t] || "#888" }}
              />
              {t}
            </div>
          ))}
        </div>
      </div>

      <div className="relative border rounded-lg bg-background overflow-hidden" style={{ height: 600 }}>
        <ForceGraph3D
          ref={fgRef}
          graphData={graphData}
          nodeLabel={(node: any) => `${node.name} (${node.type})`}
          nodeColor={(node: any) => node.color}
          nodeVal={(node: any) => node.val}
          nodeOpacity={0.9}
          linkColor={() => "rgba(150,150,150,0.3)"}
          linkWidth={0.5}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          backgroundColor="#0a0a0a"
          width={typeof window !== "undefined" ? Math.min(window.innerWidth - 350, 1200) : 1000}
          height={600}
          onNodeClick={(node: any) => {
            const raw = nodes.find((n) => n.node_id === node.id);
            setSelectedNode(raw ?? null);
          }}
        />
      </div>

      {selectedNode && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ backgroundColor: TYPE_COLORS[selectedNode.type] || "#888" }}
              />
              {selectedNode.display_name}
              <Badge variant="outline" className="text-[10px]">
                {selectedNode.type}
              </Badge>
              <Badge variant="secondary" className="text-[10px]">
                {selectedNode.confidence}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            <p className="text-xs text-muted-foreground">
              ID: {selectedNode.node_id}
            </p>
            <div className="mt-2">
              <p className="text-xs font-medium">Connected edges:</p>
              <div className="space-y-1 mt-1">
                {edges
                  .filter(
                    (e) =>
                      e.source_node_id === selectedNode.node_id ||
                      e.target_node_id === selectedNode.node_id,
                  )
                  .slice(0, 10)
                  .map((e) => {
                    const otherId =
                      e.source_node_id === selectedNode.node_id
                        ? e.target_node_id
                        : e.source_node_id;
                    const other = nodes.find((n) => n.node_id === otherId);
                    return (
                      <div key={e.edge_id} className="text-[10px] flex items-center gap-1">
                        <Badge variant="outline" className="text-[9px]">
                          {e.type}
                        </Badge>
                        <span>{other?.display_name || otherId}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
