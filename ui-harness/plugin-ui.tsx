// Stand-in for @getpaseo/plugin/client/ui in the harness: only what QueueView uses (Icon, TextInput). Paseo's Icon draws
// a plugin icon ({ svg }) or a Lucide icon by name; here inline SVG goes straight into the DOM, and the
// one Lucide name in use (folder) is Lucide's path as bundled in Paseo's web UI.
import { createElement } from "react";

// Paseo's TextInput adds keyboard handling to React Native's; react-native-web's is enough here.
export { TextInput } from "react-native";

const LUCIDE: Record<string, string> = {
  folder:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
};

export function Icon(props: { name?: string; icon?: string | { svg: string }; size?: number; color?: string }) {
  const svg = typeof props.icon === "object" ? props.icon.svg : LUCIDE[props.name ?? (props.icon as string) ?? ""];
  if (!svg) return null;
  const size = props.size ?? 16;
  const sized = svg.replace(/^<svg\b/, `<svg width="${size}" height="${size}" style="display:block"`);
  return createElement("span", {
    style: { display: "inline-flex", width: size, height: size, color: props.color, flexShrink: 0 },
    dangerouslySetInnerHTML: { __html: sized },
  });
}
