"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Search, Network, Gauge, Users, ArrowRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

interface SearchResult {
  id: string;
  name: string;
  type: string;
  subtitle: string;
  status?: string;
}

interface SearchResponse {
  tunnels: { id: string; name: string; method: string; status: string }[];
  nodes: { id: string; name: string; type: string; host: string; status: string }[];
  users: { id: string; email: string; name: string; role: string }[];
}

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

interface SearchAction {
  type: "loading" | "results" | "error" | "reset";
  payload?: SearchResponse;
}

function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true };
    case "results":
      return { results: action.payload ?? EMPTY_RESULTS, loading: false };
    case "error":
      return { results: EMPTY_RESULTS, loading: false };
    case "reset":
      return { results: EMPTY_RESULTS, loading: false };
    default:
      return state;
  }
}

// Custom hook to search across tunnels, nodes, and users
function useSearchResults(debouncedQuery: string) {
  const [searchState, dispatch] = React.useReducer(searchReducer, {
    results: EMPTY_RESULTS,
    loading: false,
  });
  const prevQueryRef = React.useRef(debouncedQuery);

  React.useEffect(() => {
    // Skip if query hasn't actually changed
    if (debouncedQuery === prevQueryRef.current) return;
    prevQueryRef.current = debouncedQuery;

    // Don't search for short queries
    if (debouncedQuery.length < 2) {
      dispatch({ type: "reset" });
      return;
    }
    let cancelled = false;
    dispatch({ type: "loading" });
    fetch(`/api/search?q=${encodeURIComponent(debouncedQuery)}`)
      .then((r) => r.json())
      .then((data: SearchResponse) => {
        if (!cancelled) {
          dispatch({ type: "results", payload: data });
        }
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "error" });
      });
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  const isShortQuery = debouncedQuery.length < 2;
  return isShortQuery ? { results: EMPTY_RESULTS, loading: false } : searchState;
}

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SearchState {
  results: SearchResponse;
  loading: boolean;
}

const EMPTY_RESULTS: SearchResponse = { tunnels: [], nodes: [], users: [] };

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const t = useTranslations();
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const debouncedQuery = useDebouncedValue(query, 300);
  const searchState = useSearchResults(debouncedQuery);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setQuery("");
        setActiveIndex(0);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  // Flatten all results into a single list for keyboard navigation
  const flatResults: SearchResult[] = React.useMemo(() => {
    const items: SearchResult[] = [];
    for (const t of searchState.results.tunnels) {
      items.push({
        id: t.id,
        name: t.name,
        type: "tunnel",
        subtitle: t.method,
        status: t.status,
      });
    }
    for (const n of searchState.results.nodes) {
      items.push({
        id: n.id,
        name: n.name,
        type: "node",
        subtitle: n.host,
        status: n.status,
      });
    }
    for (const u of searchState.results.users) {
      items.push({
        id: u.id,
        name: u.name,
        type: "user",
        subtitle: u.email,
      });
    }
    return items;
  }, [searchState.results]);

  const navigate = React.useCallback(
    (item: SearchResult) => {
      onOpenChange(false);
      if (item.type === "tunnel") router.push(`/tunnels/${item.id}`);
      else if (item.type === "node") router.push(`/nodes/${item.id}`);
      else router.push(`/users/${item.id}`);
    },
    [router, onOpenChange],
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flatResults[activeIndex];
        if (item) navigate(item);
      }
    },
    [flatResults, activeIndex, navigate],
  );

  // Scroll active item into view
  React.useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const totalResults = flatResults.length;
  const showEmpty = debouncedQuery.length >= 2 && !searchState.loading && totalResults === 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-xl"
        onKeyDown={handleKeyDown}
      >
        <DialogDescription className="sr-only">
          {t("search.description")}
        </DialogDescription>
        <div className="flex items-center border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            className="border-0 bg-transparent px-3 py-3 text-sm shadow-none focus-visible:ring-0"
          />
          {searchState.loading && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>

        <ScrollArea className="h-80">
          <div ref={listRef} className="p-2">
            {showEmpty && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {t("search.noResults")}
              </div>
            )}

            {debouncedQuery.length < 2 && !searchState.loading && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {t("search.hint")}
              </div>
            )}

            {searchState.results.tunnels.length > 0 && (
              <ResultGroup
                icon={<Network className="h-3.5 w-3.5" />}
                label={t("search.tunnels")}
              >
                {searchState.results.tunnels.map((tunnel, i) => (
                  <ResultItem
                    key={tunnel.id}
                    index={i}
                    active={activeIndex === i}
                    item={{
                      id: tunnel.id,
                      name: tunnel.name,
                      type: "tunnel",
                      subtitle: tunnel.method,
                      status: tunnel.status,
                    }}
                    onSelect={navigate}
                    onHover={setActiveIndex}
                  />
                ))}
              </ResultGroup>
            )}

            {searchState.results.nodes.length > 0 && (
              <ResultGroup
                icon={<Gauge className="h-3.5 w-3.5" />}
                label={t("search.nodes")}
              >
                {searchState.results.nodes.map((node, i) => {
                  const globalIdx = searchState.results.tunnels.length + i;
                  return (
                    <ResultItem
                      key={node.id}
                      index={globalIdx}
                      active={activeIndex === globalIdx}
                      item={{
                        id: node.id,
                        name: node.name,
                        type: "node",
                        subtitle: node.host,
                        status: node.status,
                      }}
                      onSelect={navigate}
                      onHover={setActiveIndex}
                    />
                  );
                })}
              </ResultGroup>
            )}

            {searchState.results.users.length > 0 && (
              <ResultGroup
                icon={<Users className="h-3.5 w-3.5" />}
                label={t("search.users")}
              >
                {searchState.results.users.map((user, i) => {
                  const globalIdx =
                    searchState.results.tunnels.length + searchState.results.nodes.length + i;
                  return (
                    <ResultItem
                      key={user.id}
                      index={globalIdx}
                      active={activeIndex === globalIdx}
                      item={{
                        id: user.id,
                        name: user.name,
                        type: "user",
                        subtitle: user.email,
                      }}
                      onSelect={navigate}
                      onHover={setActiveIndex}
                    />
                  );
                })}
              </ResultGroup>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between border-t px-3 py-1.5">
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">&uarr;</kbd>
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">&darr;</kbd>
              navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">&crarr;</kbd>
              select
            </span>
          </div>
          {totalResults > 0 && (
            <span className="text-xs text-muted-foreground">
              {totalResults} result{totalResults !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultGroup({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function ResultItem({
  index,
  active,
  item,
  onSelect,
  onHover,
}: {
  index: number;
  active: boolean;
  item: SearchResult;
  onSelect: (item: SearchResult) => void;
  onHover: (index: number) => void;
}) {
  const typeIcon =
    item.type === "tunnel" ? (
      <Network className="h-4 w-4 text-muted-foreground" />
    ) : item.type === "node" ? (
      <Gauge className="h-4 w-4 text-muted-foreground" />
    ) : (
      <Users className="h-4 w-4 text-muted-foreground" />
    );

  const typeColor =
    item.type === "tunnel"
      ? "bg-primary/10 text-primary"
      : item.type === "node"
        ? "bg-success/15 text-success"
        : "bg-warning/15 text-warning";

  return (
    <div
      data-index={index}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onHover(index)}
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
          typeColor,
        )}
      >
        {typeIcon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{item.name}</span>
          {item.status && <StatusBadge status={item.status} />}
        </div>
        <span className="text-xs text-muted-foreground truncate block">
          {item.subtitle}
        </span>
      </div>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </div>
  );
}
