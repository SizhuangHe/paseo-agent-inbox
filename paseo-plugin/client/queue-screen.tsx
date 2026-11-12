// The inbox screen and the sidebar row: data from the plugin RPCs, polled while shown.
import { openExternalUrl, useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { copyText, Loading, ScrollView, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View, type ScrollView as NativeScrollView } from "react-native";
import { externalSessionUrl, type Picks } from "../shared/cards";
import { clientCopyDeps, copyWithFallback } from "../shared/clipboard";
import {
  answerPermission,
  listQueue,
  markCardDone,
  sendAnswers,
  snoozeCard,
  type PermissionAnswer,
  type QueueAsk,
  type QueueCard,
} from "../shared/rpc";
import { isOpenableUrl } from "./format";
import { QueueView, type PermissionState } from "./queue-view";

export const QUEUE_SCREEN_ID = "queue";
const QUERY_KEY = ["agent-queue", "list"] as const;
const POLL_MS = 5_000;

function useQueueList() {
  const list = useRpc(listQueue);
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => ({ ...(await list({})), fetchedAt: Date.now() }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/** Re-renders every half minute so wait times move between polls. */
function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

export function QueueScreen({ theme, layout, navigation }: PluginScreenProps) {
  const query = useQueueList();
  const queryClient = useQueryClient();
  const toast = useToast();
  const snooze = useRpc(snoozeCard);
  const done = useRpc(markCardDone);
  const answer = useRpc(sendAnswers);
  const respond = useRpc(answerPermission);
  const [permissionStates, setPermissionStates] = useState<Record<string, PermissionState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scroll = useRef<NativeScrollView>(null);
  useTick(30_000);
  // Overview and detail each start at the top.
  useEffect(() => scroll.current?.scrollTo({ y: 0, animated: false }), [selectedId]);

  const settle = useMutation({
    mutationFn: async ({ card, kind }: { card: QueueCard; kind: "snooze" | "done" }) =>
      kind === "snooze" ? snooze({ cardId: card.id }) : done({ cardId: card.id }),
    onSuccess: ({ card }, { kind }) => {
      // A dismissed card with a permission still pending stays open, showing just that request.
      if (kind === "snooze" || card.state !== "open") setSelectedId(null);
      return queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const send = useMutation({
    mutationFn: ({ card, picks, reply }: { card: QueueCard; picks: Picks; reply: string }) =>
      answer({ cardId: card.id, picks, ...(reply.trim() ? { reply } : {}) }),
    onSuccess: ({ card }) => {
      toast.show("Sent");
      if (card.state !== "open") setSelectedId(null);
      return queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  // A permission answer goes out at once; its row shows busy, then how it went (or the error as a toast).
  const setPermission = (key: string, state: PermissionState | null) =>
    setPermissionStates((all) => {
      const next = { ...all };
      if (state) next[key] = state;
      else delete next[key];
      return next;
    });
  const permission = useMutation({
    mutationFn: ({ card, ask, answer: choice }: { card: QueueCard; ask: QueueAsk; answer: PermissionAnswer }) =>
      respond({ cardId: card.id, askId: ask.id, answer: choice }),
    onMutate: ({ card, ask }) => setPermission(`${card.id}/${ask.id}`, "busy"),
    onSuccess: ({ outcome }, { card, ask }) => {
      setPermission(`${card.id}/${ask.id}`, outcome);
      return queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error, { card, ask }) => {
      setPermission(`${card.id}/${ask.id}`, null);
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const openAgent = navigation?.openAgent;
  // Cards from an external host open the page AGENT_INBOX_EXTERNAL_URL names; without it they have no button.
  const externalUrl = query.data?.externalUrl ?? null;
  const canOpenSession = (card: QueueCard) => (card.host === "paseo" ? Boolean(openAgent) : externalUrl !== null);
  const onOpenSession = (card: QueueCard) => {
    if (card.host === "paseo") {
      openAgent?.({ agentId: card.sessionId });
      return;
    }
    if (!externalUrl) return;
    const url = externalSessionUrl(externalUrl, card.sessionId);
    if (!isOpenableUrl(url)) return;
    void openExternalUrl(url).catch((error: unknown) => toast.error(String(error)));
  };

  const onOpenUrl = (url: string) => {
    if (!isOpenableUrl(url)) return;
    void openExternalUrl(url).catch((error: unknown) => toast.error(String(error)));
  };

  // Over plain http the clipboard API is missing: copy through a hidden textarea instead, and when
  // that fails too the card shows the path to select by hand (no error toast).
  const onCopyPath = async (path: string): Promise<boolean> => {
    const copied = await copyWithFallback(path, clientCopyDeps(copyText));
    if (copied) toast.show("Path copied");
    return copied;
  };

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <View style={{ flex: 1, padding: layout.compact ? 16 : 32, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 14 }}>{query.error.message}</Text>
      </View>
    );
  }

  const { fetchedAt, ...data } = query.data;
  return (
    <ScrollView ref={scroll} style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <QueueView
        theme={theme}
        compact={layout.compact}
        data={data}
        clockSkewMs={Date.now() - fetchedAt}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenSession={onOpenSession}
        canOpenSession={canOpenSession}
        onSnooze={(card) => settle.mutate({ card, kind: "snooze" })}
        onDone={(card) => settle.mutate({ card, kind: "done" })}
        onAnswer={(card, picks, reply) => send.mutate({ card, picks, reply })}
        onPermission={(card, ask, choice) => permission.mutate({ card, ask, answer: choice })}
        permissionStates={permissionStates}
        onOpenUrl={onOpenUrl}
        onCopyPath={onCopyPath}
        busyCardId={
          settle.isPending ? settle.variables?.card.id ?? null : send.isPending ? send.variables?.card.id ?? null : null
        }
      />
    </ScrollView>
  );
}

export function QueueSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const query = useQueueList();
  const count = query.data?.cards.length ?? 0;
  return (
    <SidebarRow
      icon="Inbox"
      label="Inbox"
      active={currentScreen?.screenId === QUEUE_SCREEN_ID}
      onPress={() => openScreen({ screenId: QUEUE_SCREEN_ID })}
      trailing={
        <Text
          style={{
            color: count ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 13,
            fontWeight: count ? "600" : "400",
            fontVariant: ["tabular-nums"],
          }}
        >
          {count}
        </Text>
      }
    />
  );
}
