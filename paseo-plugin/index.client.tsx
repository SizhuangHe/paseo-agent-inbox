import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QUEUE_SCREEN_ID, QueueScreen, QueueSidebarItem } from "./client/queue-screen";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: QUEUE_SCREEN_ID, title: "Inbox", Component: QueueScreen }),
    client.addSidebarHeaderItem({ id: QUEUE_SCREEN_ID, title: "Inbox", Component: QueueSidebarItem }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
