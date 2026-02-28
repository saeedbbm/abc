"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Edit3,
  MessageSquare,
  AlertCircle,
  AlertTriangle,
  Info,
  ShieldAlert,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VerifyCard {
  card_id: string;
  card_type: string;
  severity: string;
  title: string;
  explanation: string;
  canonical_text: string;
  proposed_text?: string;
  page_occurrences: { page_id: string; section: string; item_index: number }[];
  assigned_to: string[];
  status: string;
  discussion: { author: string; text: string; timestamp: string }[];
}

interface GraphNode {
  node_id: string;
  display_name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ["S1", "S2", "S3", "S4"];
const SEVERITY_CONFIG: Record<
  string,
  { icon: typeof AlertCircle; color: string; badgeClass: string; label: string }
> = {
  S1: {
    icon: AlertCircle,
    color: "text-red-500",
    badgeClass: "bg-red-500/10 text-red-500 border-red-500/20",
    label: "Critical",
  },
  S2: {
    icon: AlertTriangle,
    color: "text-orange-500",
    badgeClass: "bg-orange-500/10 text-orange-500 border-orange-500/20",
    label: "High",
  },
  S3: {
    icon: Info,
    color: "text-yellow-500",
    badgeClass: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    label: "Medium",
  },
  S4: {
    icon: ShieldAlert,
    color: "text-blue-500",
    badgeClass: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    label: "Low",
  },
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KB2VerifyPage({ companySlug }: { companySlug: string }) {
  const [cards, setCards] = useState<VerifyCard[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [selectedCard, setSelectedCard] = useState<VerifyCard | null>(null);
  const [expandedSeverities, setExpandedSeverities] = useState<Set<string>>(
    new Set(SEVERITY_ORDER)
  );
  const [chatInput, setChatInput] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");

  const fetchData = useCallback(async () => {
    const [cRes, nRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=verify_cards`),
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`),
    ]);
    const cData = await cRes.json();
    const nData = await nRes.json();
    setCards(cData.cards ?? []);
    const allNodes: GraphNode[] = nData.nodes ?? [];
    const seen = new Set<string>();
    const deduped = allNodes.filter((n) => {
      if (n.type !== "person" || seen.has(n.node_id)) return false;
      seen.add(n.node_id);
      return true;
    });
    setNodes(deduped);
  }, [companySlug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleSeverity = (sev: string) => {
    setExpandedSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  };

  const filteredCards =
    personFilter === "all"
      ? cards
      : cards.filter((c) => c.assigned_to.includes(personFilter));

  const cardsBySeverity = SEVERITY_ORDER.reduce(
    (acc, sev) => {
      acc[sev] = filteredCards.filter((c) => c.severity === sev);
      return acc;
    },
    {} as Record<string, VerifyCard[]>
  );

  const handleAction = async (
    action: "validate" | "reject",
    cardId: string
  ) => {
    await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardId,
        action,
        comment: chatInput || undefined,
      }),
    });
    setChatInput("");
    await fetchData();
    setSelectedCard(null);
  };

  const handleEdit = async (cardId: string) => {
    await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardId,
        action: "edit",
        editText,
        comment: chatInput || undefined,
      }),
    });
    setChatInput("");
    setEditMode(false);
    setEditText("");
    await fetchData();
    setSelectedCard(null);
  };

  return (
    <div className="flex h-full">
      {/* Left panel: severity tree + person filter */}
      <div className="w-72 border-r flex flex-col">
        <div className="p-4 border-b space-y-2">
          <h2 className="text-sm font-medium">Verification Queue</h2>
          <Select value={personFilter} onValueChange={setPersonFilter}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Filter by person..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({cards.length})</SelectItem>
              {nodes.map((node) => (
                <SelectItem key={node.node_id} value={node.node_id}>
                  {node.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ScrollArea className="flex-1 p-2">
          {SEVERITY_ORDER.map((sev) => {
            const sevCards = cardsBySeverity[sev] ?? [];
            const cfg = SEVERITY_CONFIG[sev];
            const isExpanded = expandedSeverities.has(sev);
            const Icon = cfg.icon;
            return (
              <div key={sev} className="mb-1">
                <button
                  onClick={() => toggleSeverity(sev)}
                  className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium rounded hover:bg-accent"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Icon className={`h-3 w-3 ${cfg.color}`} />
                  {sev} &mdash; {cfg.label}
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    {sevCards.length}
                  </Badge>
                </button>
                {isExpanded && (
                  <div className="ml-4 space-y-0.5">
                    {sevCards.length === 0 ? (
                      <div className="text-[10px] text-muted-foreground px-2 py-1">
                        No cards
                      </div>
                    ) : (
                      sevCards.map((card) => (
                        <button
                          key={card.card_id}
                          onClick={() => {
                            setSelectedCard(card);
                            setEditMode(false);
                            setEditText("");
                          }}
                          className={`w-full text-left px-2 py-1 text-xs rounded transition-colors truncate ${
                            selectedCard?.card_id === card.card_id
                              ? "bg-accent font-medium"
                              : "hover:bg-accent/50"
                          }`}
                        >
                          <Badge
                            variant="outline"
                            className="text-[9px] mr-1"
                          >
                            {card.card_type}
                          </Badge>
                          {card.title.slice(0, 50)}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </ScrollArea>
      </div>

      {/* Center panel: card detail */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedCard ? (
          <ScrollArea className="flex-1 p-6">
            <div className="max-w-2xl">
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <Badge>{selectedCard.card_type}</Badge>
                <Badge
                  variant="outline"
                  className={
                    SEVERITY_CONFIG[selectedCard.severity]?.badgeClass
                  }
                >
                  {selectedCard.severity} &mdash;{" "}
                  {SEVERITY_CONFIG[selectedCard.severity]?.label}
                </Badge>
                <Badge variant="outline">{selectedCard.status}</Badge>
              </div>

              <h2 className="text-lg font-semibold mb-2">
                {selectedCard.title}
              </h2>
              <p className="text-sm mb-4">{selectedCard.explanation}</p>

              <Card className="mb-4">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">What to decide</CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  <p className="text-sm">
                    Review the canonical text below and decide whether to
                    validate, edit, or reject this card.
                  </p>
                </CardContent>
              </Card>

              <Card className="mb-4">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Canonical text</CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  {editMode ? (
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      className="text-sm font-mono min-h-[100px]"
                    />
                  ) : (
                    <p className="text-sm font-mono bg-muted p-3 rounded">
                      {selectedCard.canonical_text}
                    </p>
                  )}
                </CardContent>
              </Card>

              {selectedCard.proposed_text && (
                <Card className="mb-4">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Proposed text</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <p className="text-sm font-mono bg-muted p-3 rounded">
                      {selectedCard.proposed_text}
                    </p>
                  </CardContent>
                </Card>
              )}

              {selectedCard.page_occurrences.length > 0 && (
                <Card className="mb-4">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">
                      Appears on {selectedCard.page_occurrences.length} page
                      {selectedCard.page_occurrences.length !== 1 ? "s" : ""}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3 text-xs space-y-1">
                    {selectedCard.page_occurrences.map((occ, i) => (
                      <div key={i}>
                        Page {occ.page_id.slice(0, 8)}... / {occ.section} [
                        {occ.item_index}]
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              <Card className="mb-4">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" /> Discussion
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  {selectedCard.discussion.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No comments yet.
                    </p>
                  )}
                  {selectedCard.discussion.map((msg, i) => (
                    <div
                      key={i}
                      className="text-xs mb-2 pb-2 border-b last:border-0"
                    >
                      <span className="font-medium">{msg.author}</span>{" "}
                      <span className="text-muted-foreground">
                        {new Date(msg.timestamp).toLocaleString()}
                      </span>
                      <p className="mt-1">{msg.text}</p>
                    </div>
                  ))}
                  <Textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Leave a comment..."
                    className="text-xs h-16 mt-2"
                  />
                </CardContent>
              </Card>

              <div className="flex gap-2">
                <Button
                  onClick={() =>
                    handleAction("validate", selectedCard.card_id)
                  }
                  className="bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle2 className="h-4 w-4 mr-1" /> Validate
                </Button>
                {editMode ? (
                  <Button
                    variant="outline"
                    onClick={() => handleEdit(selectedCard.card_id)}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" /> Save Edit
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditMode(true);
                      setEditText(selectedCard.canonical_text);
                    }}
                  >
                    <Edit3 className="h-4 w-4 mr-1" /> Edit
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() =>
                    handleAction("reject", selectedCard.card_id)
                  }
                >
                  <XCircle className="h-4 w-4 mr-1" /> Reject
                </Button>
                {editMode && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditMode(false);
                      setEditText("");
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex items-center justify-center flex-1">
            <p className="text-muted-foreground">
              {cards.length === 0
                ? "No verification cards yet. Run the pipeline from KB Admin."
                : "Select a verification card from the left panel."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
