/**
 * Blocker delivery.
 *
 * A run that stops for a person and tells nobody is worse than one that never
 * stops: it looks like progress while nothing is happening. So a pause is only
 * valid once at least one channel confirms delivery, and every attempt is
 * recorded on the blocker itself.
 *
 * Two channels exist today. The file channel always works and is what an
 * external watcher - or the person, later - can find without a live session;
 * the UI channel reaches whoever is at the terminal now. Adding a channel that
 * leaves the machine (push, mail, chat) means adding a `NotifyChannel` here;
 * the caller records whatever it reports.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import {
  describeBlocker,
  type Blocker,
  type NotifyRecord,
} from "./escalation.ts";
import { writeFileAtomic } from "./serialization.ts";

/** Marker a person or an external watcher can find in the run directory. */
export const NEEDS_INPUT_FILE = "NEEDS-INPUT.md";

export interface NotifyContext {
  runId: string;
  runDir: string;
  /** Absent for a headless run; the file channel still applies. */
  ui?: ExtensionContext["ui"];
}

export interface NotifyChannel {
  name: string;
  deliver(blocker: Blocker, context: NotifyContext): Promise<void>;
}

function record(channel: string, ok: boolean, detail?: string): NotifyRecord {
  return {
    channel,
    at: Date.now(),
    ok,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Writes the blocker as Markdown in the run directory. Always available. */
export const fileChannel: NotifyChannel = {
  name: "file",
  async deliver(blocker, context) {
    const body = [
      `# ${context.runId} needs input`,
      "",
      describeBlocker(blocker, context.runId),
      "",
      "---",
      `Blocker file: ${path.join("blockers", `${blocker.id}.json`)}`,
    ].join("\n");
    writeFileAtomic(path.join(context.runDir, NEEDS_INPUT_FILE), body);
  },
};

/** Notifies the terminal, when one is attached. */
export const uiChannel: NotifyChannel = {
  name: "ui",
  async deliver(blocker, context) {
    const ui = context.ui;
    if (!ui) throw new Error("no UI attached");
    ui.notify(
      `Workflow ${context.runId} is waiting on you: ${blocker.decision}`,
      "warning",
    );
  },
};

export function defaultChannels(context: NotifyContext): NotifyChannel[] {
  return context.ui ? [fileChannel, uiChannel] : [fileChannel];
}

/**
 * Try every channel and report what happened. One failing channel never stops
 * the others: the point is to get the blocker in front of someone, and a
 * channel that throws is itself worth recording.
 */
export async function deliverBlocker(
  blocker: Blocker,
  context: NotifyContext,
  channels = defaultChannels(context),
): Promise<NotifyRecord[]> {
  const records: NotifyRecord[] = [];
  for (const channel of channels) {
    try {
      await channel.deliver(blocker, context);
      records.push(record(channel.name, true));
    } catch (error) {
      records.push(
        record(
          channel.name,
          false,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return records;
}

/** True when at least one channel confirmed delivery. */
export function wasDelivered(records: readonly NotifyRecord[]): boolean {
  return records.some((entry) => entry.ok);
}
