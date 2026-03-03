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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  Send,
  UserPlus,
  Loader2,
  Users,
  Eye,
} from "lucide-react";
import { KB2RightPanel } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";

interface VerifyCard {
  card_id: string;
  card_type: string;
  severity: string;
  title: string;
  explanation: string;
  description?: string;
  canonical_text: string;
  proposed_text?: string;
  recommended_action?: string;
  source_refs?: {
    source_type: string;
    doc_id: string;
    title: string;
    excerpt?: string;
    section_heading?: string;
  }[];
  page_occurrences: {
    page_id: string;
    page_type?: string;
    page_title?: string;
    section?: string;
    item_index?: number;
  }[];
  assigned_to: string[];
  status: string;
  discussion: { author: string; text: string; timestamp: string }[];
}

interface GraphNode {
  node_id: string;
  display_name: string;
  type: string;
}

interface DraftCard {
  id: string;
  title: string;
  targetType: string;
  beforeText: string;
  afterText: string;
  accepted: boolean | null;
}

interface Person {
  id: string;
  name: string;
  email?: string;
}

const SEVERITY_ORDER = ["S1", "S2", "S3", "S4"];
const SEVERITY_CONFIG: Record<string, { icon: typeof AlertCircle; color: string; bgColor: string; pillClass: string; label: string }> = {
  S1: { icon: AlertCircle, color: "text-red-600", bgColor: "bg-red-500", pillClass: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400", label: "Critical" },
  S2: { icon: AlertTriangle, color: "text-orange-600", bgColor: "bg-orange-500", pillClass: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400", label: "High" },
  S3: { icon: Info, color: "text-yellow-600", bgColor: "bg-yellow-500", pillClass: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400", label: "Medium" },
  S4: { icon: ShieldAlert, color: "text-blue-600", bgColor: "bg-blue-500", pillClass: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", label: "Low" },
};

const STATUS_ICONS: Record<string, string> = { open: "⏳", validated: "✅", rejected: "❌" };

export function KB2VerifyPage({ companySlug }: { companySlug: string }) {
  const [cards, setCards] = useState<VerifyCard[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [expandedSeverities, setExpandedSeverities] = useState<Set<string>>(new Set(SEVERITY_ORDER));
  const [commentText, setCommentText] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [assigningOwner, setAssigningOwner] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"queue" | "verified">("queue");

  const [modifyText, setModifyText] = useState("");
  const [draftCards, setDraftCards] = useState<DraftCard[]>([]);
  const [checkingModification, setCheckingModification] = useState(false);
  const [checkStats, setCheckStats] = useState<{ pagesScanned?: number; pagesMatched?: number; ticketsMatched?: number; questions?: string[]; reasoning?: string; affectedNames?: string[] } | null>(null);
  const [coworkerPerson, setCoworkerPerson] = useState("");
  const [coworkerComment, setCoworkerComment] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [addingReviewer, setAddingReviewer] = useState(false);
  const [reviewerToAdd, setReviewerToAdd] = useState("");

  const selectedCard = cards.find((c) => c.card_id === selectedCardId) ?? null;

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
    setNodes(allNodes.filter((n) => {
      if (n.type !== "person" || seen.has(n.node_id)) return false;
      seen.add(n.node_id);
      return true;
    }));
  }, [companySlug]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    fetch(`/api/${companySlug}/kb2?type=people`)
      .then((r) => r.json())
      .then((data) => {
        const raw = data.people ?? [];
        const seen = new Set<string>();
        const deduped: Person[] = [];
        for (const p of raw) {
          const name = (p.display_name ?? p.name ?? "").trim();
          if (!name || seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());
          deduped.push({
            id: p.person_id ?? p.id ?? p.node_id ?? name,
            name,
            email: p.email ?? "",
          });
        }
        setPeople(deduped);
      })
      .catch(() => {});
  }, [companySlug]);

  const toggleSeverity = (sev: string) => {
    setExpandedSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      return next;
    });
  };

  const selectCard = (cardId: string) => {
    setSelectedCardId(cardId);
    setCommentText("");
    setOwnerInput("");
    setModifyText("");
    setDraftCards([]);
    setCoworkerPerson("");
    setCoworkerComment("");
    setReviewers([]);
    setAddingReviewer(false);
    setReviewerToAdd("");
  };

  const filteredCards = personFilter === "all" ? cards : cards.filter((c) => c.assigned_to.includes(personFilter));
  const openCards = filteredCards.filter((c) => c.status === "open");
  const verifiedCards = filteredCards.filter((c) => c.status === "validated" || c.status === "rejected");
  const cardsBySeverity = SEVERITY_ORDER.reduce((acc, sev) => {
    acc[sev] = openCards.filter((c) => c.severity === sev);
    return acc;
  }, {} as Record<string, VerifyCard[]>);

  const handleAction = async (action: "validate" | "reject", cardId: string) => {
    const res = await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId, action, comment: commentText || undefined }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      alert(`Failed to ${action}: ${err.error ?? res.statusText}`);
      return;
    }
    setCommentText("");
    await fetchData();
    setSelectedCardId(null);
  };

  const handleAddComment = async () => {
    if (!selectedCard || !commentText.trim()) return;
    const res = await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: selectedCard.card_id, action: "comment", comment: commentText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      alert(`Failed to add comment: ${err.error ?? res.statusText}`);
      return;
    }
    setCommentText("");
    await fetchData();
  };

  const handleDuplicateAction = async (action: "merge_entities" | "keep_separate") => {
    if (!selectedCard) return;
    const res = await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: selectedCard.card_id, action }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      alert(`Action failed: ${err.error ?? res.statusText}`);
      return;
    }
    await fetchData();
  };

  const handleAssignOwner = async () => {
    if (!selectedCard || !ownerInput.trim()) return;
    setAssigningOwner(true);
    try {
      for (const occ of selectedCard.page_occurrences) {
        await fetch(`/api/${companySlug}/kb2?type=entity_page_edit`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page_id: occ.page_id,
            section_index: 0,
            item_index: 0,
            new_text: `Owner: ${ownerInput}`,
            append: true,
          }),
        });
      }
      await handleAction("validate", selectedCard.card_id);
    } finally {
      setAssigningOwner(false);
      setOwnerInput("");
    }
  };

  const handleCheckModification = async () => {
    if (!selectedCard || !modifyText.trim()) return;
    setCheckingModification(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/verify/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: selectedCard.card_id, modificationText: modifyText }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          setDraftCards([]);
          alert("Check endpoint not yet available — coming soon.");
          return;
        }
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        alert(`Check failed: ${err.error ?? res.statusText}`);
        return;
      }
      const data = await res.json();
      setDraftCards(
        (data.drafts ?? []).map((d: DraftCard) => ({ ...d, accepted: null }))
      );
      const dbg = data.debug ?? {};
      setCheckStats({
        pagesScanned: dbg.pagesScanned ?? data.pagesScanned,
        pagesMatched: dbg.pagesMatched ?? data.pagesMatched,
        ticketsMatched: dbg.ticketsMatched ?? data.ticketsMatched,
        questions: data.questions,
        reasoning: dbg.reasoning,
        affectedNames: dbg.affectedNames,
      });
    } catch {
      alert("Check endpoint not yet available — coming soon.");
      setDraftCards([]);
    } finally {
      setCheckingModification(false);
    }
  };

  const handleDraftAction = (draftId: string, accepted: boolean) => {
    setDraftCards((prev) =>
      prev.map((d) => (d.id === draftId ? { ...d, accepted } : d))
    );
  };

  const handleAcceptAllDrafts = () => {
    setDraftCards((prev) => prev.map((d) => ({ ...d, accepted: true })));
  };

  const handleAddReviewer = () => {
    if (!reviewerToAdd) return;
    setReviewers((prev) => (prev.includes(reviewerToAdd) ? prev : [...prev, reviewerToAdd]));
    setReviewerToAdd("");
    setAddingReviewer(false);
  };

  const handleRemoveReviewer = (name: string) => {
    setReviewers((prev) => prev.filter((r) => r !== name));
  };

  const handleSendToCoworker = async () => {
    if (!selectedCard || !coworkerPerson || !coworkerComment.trim()) return;
    setReviewers((prev) =>
      prev.includes(coworkerPerson) ? prev : [...prev, coworkerPerson]
    );
    const res = await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardId: selectedCard.card_id,
        action: "comment",
        comment: `[To ${coworkerPerson}] ${coworkerComment}`,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      alert(`Failed: ${err.error ?? res.statusText}`);
      return;
    }
    setCoworkerComment("");
    setCoworkerPerson("");
    await fetchData();
  };

  const parseDuplicateEntities = (text: string): Record<string, unknown>[] | null => {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed.entities ?? [parsed];
      return list.length >= 2 ? list : null;
    } catch {
      return null;
    }
  };

  return (
    <TooltipProvider>
      <div className="flex h-full flex-1 min-w-0 overflow-hidden">
        {/* Left sidebar */}
        <div className="w-64 shrink-0 border-r flex flex-col">
          <div className="p-3 border-b space-y-2">
            <h2 className="text-sm font-medium">Verification Queue</h2>
            <div className="flex rounded-md bg-muted p-0.5">
              <button
                onClick={() => setSidebarTab("queue")}
                className={`flex-1 text-xs font-medium py-1 px-2 rounded-sm transition-colors ${
                  sidebarTab === "queue"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Queue
                <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{openCards.length}</Badge>
              </button>
              <button
                onClick={() => setSidebarTab("verified")}
                className={`flex-1 text-xs font-medium py-1 px-2 rounded-sm transition-colors ${
                  sidebarTab === "verified"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Verified
                <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{verifiedCards.length}</Badge>
              </button>
            </div>
            <Select value={personFilter} onValueChange={setPersonFilter}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Filter by person..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ({cards.length})</SelectItem>
                {nodes.map((node) => (
                  <SelectItem key={node.node_id} value={node.display_name}>{node.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ScrollArea className="flex-1">
            {sidebarTab === "queue" ? (
              <div className="p-2">
                {SEVERITY_ORDER.map((sev) => {
                  const sevCards = cardsBySeverity[sev] ?? [];
                  const cfg = SEVERITY_CONFIG[sev];
                  const isExpanded = expandedSeverities.has(sev);
                  return (
                    <div key={sev} className="mb-1">
                      <button
                        onClick={() => toggleSeverity(sev)}
                        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium rounded hover:bg-accent"
                      >
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${cfg.pillClass}`}>
                          {sev} {cfg.label}
                        </span>
                        <Badge variant="secondary" className="ml-auto text-[10px]">{sevCards.length}</Badge>
                      </button>
                      {isExpanded && (
                        <div className="ml-2 space-y-0.5 mt-0.5">
                          {sevCards.length === 0 ? (
                            <div className="text-[10px] text-muted-foreground px-2 py-1">No cards</div>
                          ) : (
                            sevCards.map((card) => (
                              <Tooltip key={card.card_id}>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() => selectCard(card.card_id)}
                                    className={`w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                                      selectedCardId === card.card_id
                                        ? "bg-accent font-medium"
                                        : "hover:bg-accent/50"
                                    }`}
                                  >
                                    <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.bgColor}`} />
                                    <span className="text-xs truncate flex-1">{card.title}</span>
                                    <span className="text-[10px] shrink-0">{STATUS_ICONS[card.status] ?? ""}</span>
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="max-w-xs">
                                  <p className="text-xs">{card.title}</p>
                                </TooltipContent>
                              </Tooltip>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-2 space-y-0.5">
                {verifiedCards.length === 0 ? (
                  <div className="text-xs text-muted-foreground px-2 py-4 text-center">No verified items yet.</div>
                ) : (
                  verifiedCards.map((card) => {
                    const cfg = SEVERITY_CONFIG[card.severity];
                    const isValidated = card.status === "validated";
                    return (
                      <Tooltip key={card.card_id}>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => selectCard(card.card_id)}
                            className={`w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                              selectedCardId === card.card_id
                                ? "bg-accent font-medium"
                                : "hover:bg-accent/50"
                            }`}
                          >
                            {isValidated
                              ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                              : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                            }
                            <span className="text-xs truncate flex-1">{card.title}</span>
                            <span className={`w-2 h-2 rounded-full shrink-0 ${cfg?.bgColor ?? "bg-gray-400"}`} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <p className="text-xs">{card.title}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {isValidated ? "Validated" : "Rejected"} · {card.severity}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })
                )}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Middle + Right */}
        <SplitLayout
          autoSaveId="verify"
          mainContent={
            selectedCard ? (
              <ScrollArea className="h-full">
                <div className="max-w-2xl mx-auto p-6">
                  {/* Title + badges */}
                  <h2 className="text-xl font-semibold mb-3">{selectedCard.title}</h2>
                  <div className="flex items-center gap-2 mb-4 flex-wrap">
                    <Badge>{selectedCard.card_type}</Badge>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${SEVERITY_CONFIG[selectedCard.severity]?.pillClass ?? ""}`}>
                      {selectedCard.severity} — {SEVERITY_CONFIG[selectedCard.severity]?.label}
                    </span>
                    <Badge variant="outline">{selectedCard.status}</Badge>
                    {selectedCard.assigned_to.length > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        Assigned: {selectedCard.assigned_to.join(", ")}
                      </Badge>
                    )}
                  </div>

                  {/* Description */}
                  <p className="text-sm mb-4">{selectedCard.description || selectedCard.explanation}</p>

                  {/* Recommended action */}
                  {selectedCard.recommended_action && (
                    <div className="mb-4 p-3 border-l-4 border-blue-500 bg-blue-500/5 rounded-r-md">
                      <p className="text-xs font-medium text-blue-600 mb-1">Recommended Action</p>
                      <p className="text-sm">{selectedCard.recommended_action}</p>
                    </div>
                  )}

                  {/* Owner assignment for unknown_owner cards */}
                  {selectedCard.card_type === "unknown_owner" && selectedCard.status === "open" && (
                    <Card className="mb-4 border-amber-200 bg-amber-50/50 dark:bg-amber-900/10">
                      <CardContent className="py-4">
                        <div className="flex items-center gap-2 mb-2">
                          <UserPlus className="h-4 w-4 text-amber-600" />
                          <span className="text-sm font-medium">Assign Owner</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-3">
                          Enter the name of the person or team who should own this.
                        </p>
                        <div className="flex gap-2">
                          <Input
                            value={ownerInput}
                            onChange={(e) => setOwnerInput(e.target.value)}
                            placeholder="Person or team name..."
                            className="h-8 text-xs flex-1"
                            onKeyDown={(e) => { if (e.key === "Enter") handleAssignOwner(); }}
                          />
                          <Button size="sm" className="h-8" onClick={handleAssignOwner} disabled={assigningOwner || !ownerInput.trim()}>
                            {assigningOwner ? <Loader2 className="h-3 w-3 animate-spin" /> : "Assign"}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Duplicate cluster handling */}
                  {selectedCard.card_type === "duplicate_cluster" && (() => {
                    const entities = parseDuplicateEntities(selectedCard.canonical_text);
                    if (!entities) return null;
                    return (
                      <Card className="mb-4">
                        <CardHeader className="py-3">
                          <CardTitle className="text-sm">Potential Duplicates</CardTitle>
                        </CardHeader>
                        <CardContent className="pb-3">
                          <div className="grid grid-cols-2 gap-4">
                            {entities.slice(0, 2).map((ent, i) => (
                              <div key={i} className="border rounded-md p-3 text-xs space-y-0.5">
                                <p className="font-medium mb-1">Entity {i + 1}</p>
                                {Object.entries(ent).map(([k, v]) => (
                                  <div key={k}>
                                    <span className="text-muted-foreground">{k}:</span> {String(v)}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                          <div className="flex gap-2 mt-3">
                            <Button size="sm" onClick={() => handleDuplicateAction("merge_entities")}>Merge</Button>
                            <Button size="sm" variant="outline" onClick={() => handleDuplicateAction("keep_separate")}>Keep Separate</Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })()}

                  {/* Comments + Reviewers */}
                  <Card className="mb-4">
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" /> Comments
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-3 space-y-3">
                      {selectedCard.discussion.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No comments yet.</p>
                      ) : (
                        <div className="space-y-0">
                          {selectedCard.discussion.map((msg, i) => (
                            <div key={i} className="text-xs py-2 border-b last:border-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{msg.author}</span>
                                <span className="text-muted-foreground text-[10px]">
                                  {new Date(msg.timestamp).toLocaleString()}
                                </span>
                              </div>
                              <p className="mt-1">{msg.text}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="space-y-2">
                        <Textarea
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          placeholder="Leave a comment..."
                          className="text-xs h-16"
                        />
                        <Button size="sm" variant="outline" onClick={handleAddComment} disabled={!commentText.trim()}>
                          <Send className="h-3 w-3 mr-1" /> Send
                        </Button>
                      </div>

                      {/* Reviewers */}
                      <div className="pt-2 border-t">
                        <div className="flex items-center gap-2 mb-2">
                          <Users className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs font-medium">Reviewers</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {reviewers.length === 0 && (
                            <span className="text-[10px] text-muted-foreground">No reviewers assigned.</span>
                          )}
                          {reviewers.map((r) => (
                            <Badge key={r} variant="secondary" className="text-[10px] gap-1 pr-1">
                              {r}
                              <button
                                onClick={() => handleRemoveReviewer(r)}
                                className="ml-0.5 hover:text-destructive"
                              >
                                <XCircle className="h-2.5 w-2.5" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                        {addingReviewer ? (
                          <div className="flex gap-2">
                            <Select value={reviewerToAdd} onValueChange={setReviewerToAdd}>
                              <SelectTrigger className="h-7 text-xs flex-1">
                                <SelectValue placeholder="Select person..." />
                              </SelectTrigger>
                              <SelectContent>
                                {people
                                  .filter((p) => p.name && !reviewers.includes(p.name))
                                  .map((p) => (
                                    <SelectItem key={p.id || p.name} value={p.name}>
                                      {p.name}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            <Button size="sm" className="h-7 text-xs" onClick={handleAddReviewer} disabled={!reviewerToAdd}>
                              Add
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAddingReviewer(false); setReviewerToAdd(""); }}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddingReviewer(true)}>
                            <UserPlus className="h-3 w-3 mr-1" /> Add Reviewer
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Modify / Ask a Coworker tabs */}
                  <Card className="mb-4">
                    <CardContent className="pt-4 pb-3">
                      <Tabs defaultValue="modify">
                        <TabsList className="w-full">
                          <TabsTrigger value="modify" className="flex-1 text-xs">
                            <Edit3 className="h-3 w-3 mr-1" /> Modify
                          </TabsTrigger>
                          <TabsTrigger value="ask" className="flex-1 text-xs">
                            <Users className="h-3 w-3 mr-1" /> Ask a Coworker
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="modify" className="space-y-3">
                          <Textarea
                            value={modifyText}
                            onChange={(e) => setModifyText(e.target.value)}
                            placeholder="Describe how this should be modified..."
                            className="text-xs h-20"
                          />
                          <Button
                            size="sm"
                            onClick={handleCheckModification}
                            disabled={checkingModification || !modifyText.trim()}
                          >
                            {checkingModification ? (
                              <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking...</>
                            ) : (
                              <><Eye className="h-3 w-3 mr-1" /> Check</>
                            )}
                          </Button>

                          {/* Scan stats + questions */}
                          {checkStats && (
                            <div className="space-y-2">
                              <p className="text-[10px] text-muted-foreground">
                                Scanned {checkStats.pagesScanned ?? "?"} pages — found {checkStats.pagesMatched ?? 0} pages and {checkStats.ticketsMatched ?? 0} tickets affected
                              </p>
                              {checkStats.affectedNames && checkStats.affectedNames.length > 0 && (
                                <p className="text-[10px] text-muted-foreground">
                                  Affected nodes: {checkStats.affectedNames.join(", ")}
                                </p>
                              )}
                              {(checkStats.questions ?? []).length > 0 && (
                                <div className="rounded border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 p-2 space-y-1">
                                  <p className="text-[10px] font-medium text-yellow-800 dark:text-yellow-300">Clarification needed:</p>
                                  {(checkStats.questions ?? []).map((q, i) => (
                                    <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">• {q}</p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Draft card stack */}
                          <div className="border rounded-md">
                            {draftCards.length === 0 ? (
                              <p className="text-xs text-muted-foreground p-3 text-center">
                                Submit a modification to see affected changes.
                              </p>
                            ) : (
                              <div>
                                <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50">
                                  <span className="text-xs font-medium">
                                    {draftCards.length} affected {draftCards.length === 1 ? "item" : "items"}
                                  </span>
                                  <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={handleAcceptAllDrafts}>
                                    <CheckCircle2 className="h-3 w-3 mr-1" /> Accept All
                                  </Button>
                                </div>
                                {draftCards.map((draft) => {
                                  const beforeLines = draft.beforeText.split("\n");
                                  const afterLines = draft.afterText.split("\n");
                                  const diffLines: { type: "same" | "removed" | "added"; text: string }[] = [];
                                  const maxLen = Math.max(beforeLines.length, afterLines.length);
                                  let bi = 0, ai = 0;
                                  while (bi < beforeLines.length || ai < afterLines.length) {
                                    const bLine = bi < beforeLines.length ? beforeLines[bi] : undefined;
                                    const aLine = ai < afterLines.length ? afterLines[ai] : undefined;
                                    if (bLine !== undefined && aLine !== undefined && bLine.trim() === aLine.trim()) {
                                      diffLines.push({ type: "same", text: bLine });
                                      bi++; ai++;
                                    } else if (bLine !== undefined && (aLine === undefined || !afterLines.slice(ai).some((l) => l.trim() === bLine.trim()))) {
                                      diffLines.push({ type: "removed", text: bLine });
                                      bi++;
                                    } else if (aLine !== undefined) {
                                      diffLines.push({ type: "added", text: aLine });
                                      ai++;
                                    } else {
                                      bi++; ai++;
                                    }
                                    if (diffLines.length > maxLen + 50) break;
                                  }
                                  const changedLines = diffLines.filter((l) => l.type !== "same");
                                  const contextSize = 1;
                                  const changedIndices = new Set<number>();
                                  diffLines.forEach((l, i) => {
                                    if (l.type !== "same") {
                                      for (let j = Math.max(0, i - contextSize); j <= Math.min(diffLines.length - 1, i + contextSize); j++) {
                                        changedIndices.add(j);
                                      }
                                    }
                                  });

                                  return (
                                    <Collapsible key={draft.id}>
                                      <div className="border-b last:border-0">
                                        <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/50 group">
                                          <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                                          <span className="text-xs font-medium flex-1 truncate">{draft.title}</span>
                                          <Badge variant="outline" className="text-[9px] shrink-0">{draft.targetType.replace("_", " ")}</Badge>
                                          {changedLines.length > 0 && (
                                            <span className="text-[10px] text-muted-foreground shrink-0">
                                              {changedLines.filter((l) => l.type === "removed").length > 0 && (
                                                <span className="text-red-500">−{changedLines.filter((l) => l.type === "removed").length}</span>
                                              )}
                                              {" "}
                                              {changedLines.filter((l) => l.type === "added").length > 0 && (
                                                <span className="text-green-500">+{changedLines.filter((l) => l.type === "added").length}</span>
                                              )}
                                            </span>
                                          )}
                                          {draft.accepted === true && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                                          {draft.accepted === false && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                                        </CollapsibleTrigger>
                                        <CollapsibleContent>
                                          <div className="px-3 pb-3 space-y-2">
                                            <div className="rounded border bg-muted/30 overflow-hidden font-mono text-[11px] leading-relaxed max-h-60 overflow-y-auto">
                                              {diffLines.map((line, i) => {
                                                if (!changedIndices.has(i)) {
                                                  const prevShown = changedIndices.has(i - 1);
                                                  const nextShown = changedIndices.has(i + 1);
                                                  if (!prevShown) return null;
                                                  if (prevShown && !nextShown) {
                                                    return <div key={i} className="px-2 py-0.5 text-muted-foreground/50 text-center text-[10px]">···</div>;
                                                  }
                                                  return null;
                                                }
                                                return (
                                                  <div
                                                    key={i}
                                                    className={`px-2 py-0.5 ${
                                                      line.type === "removed"
                                                        ? "bg-red-100/80 text-red-800 dark:bg-red-900/30 dark:text-red-300 line-through"
                                                        : line.type === "added"
                                                          ? "bg-green-100/80 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                                                          : "text-muted-foreground"
                                                    }`}
                                                  >
                                                    <span className="select-none inline-block w-4 text-[9px] text-muted-foreground/60 mr-1">
                                                      {line.type === "removed" ? "−" : line.type === "added" ? "+" : " "}
                                                    </span>
                                                    {line.text || " "}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                            <div className="flex gap-2">
                                              <Button
                                                size="sm"
                                                variant={draft.accepted === true ? "default" : "outline"}
                                                className="h-6 text-[10px]"
                                                onClick={() => handleDraftAction(draft.id, true)}
                                              >
                                                <CheckCircle2 className="h-3 w-3 mr-1" /> Accept
                                              </Button>
                                              <Button
                                                size="sm"
                                                variant={draft.accepted === false ? "destructive" : "outline"}
                                                className="h-6 text-[10px]"
                                                onClick={() => handleDraftAction(draft.id, false)}
                                              >
                                                <XCircle className="h-3 w-3 mr-1" /> Reject
                                              </Button>
                                            </div>
                                          </div>
                                        </CollapsibleContent>
                                      </div>
                                    </Collapsible>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </TabsContent>

                        <TabsContent value="ask" className="space-y-3">
                          <div className="space-y-2">
                            <label className="text-xs font-medium">Person</label>
                            <Select value={coworkerPerson} onValueChange={setCoworkerPerson}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder="Select a coworker..." />
                              </SelectTrigger>
                              <SelectContent>
                                {people.filter((p) => p.name).map((p) => (
                                  <SelectItem key={p.id || p.name} value={p.name}>
                                    {p.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-medium">Message</label>
                            <Textarea
                              value={coworkerComment}
                              onChange={(e) => setCoworkerComment(e.target.value)}
                              placeholder="What would you like to ask?"
                              className="text-xs h-20"
                            />
                          </div>
                          <Button
                            size="sm"
                            onClick={handleSendToCoworker}
                            disabled={!coworkerPerson || !coworkerComment.trim()}
                          >
                            <Send className="h-3 w-3 mr-1" /> Send to Coworker
                          </Button>
                        </TabsContent>
                      </Tabs>
                    </CardContent>
                  </Card>

                  {/* Actions — secondary prominence */}
                  <div className="flex gap-2 flex-wrap pt-2 border-t">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-green-600 border-green-200 hover:bg-green-50 hover:text-green-700 dark:border-green-800 dark:hover:bg-green-900/20"
                      onClick={() => handleAction("validate", selectedCard.card_id)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Validate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700 dark:border-red-800 dark:hover:bg-red-900/20"
                      onClick={() => handleAction("reject", selectedCard.card_id)}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
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
            )
          }
          rightPanel={
            <KB2RightPanel
              companySlug={companySlug}
              autoContext={selectedCard ? { type: "verify_card", id: selectedCard.card_id, title: selectedCard.title || "Verify Card" } : null}
              sourceRefs={selectedCard?.source_refs ?? []}
              relatedEntityPages={[]}
              defaultTab="sources"
            />
          }
        />
      </div>
    </TooltipProvider>
  );
}
