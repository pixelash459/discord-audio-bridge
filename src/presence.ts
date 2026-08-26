import { ActivityType, type Client } from 'discord.js';

import { describeTrack, nowPlaying } from './audio/monitor.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { allSessions } from './voice/session.ts';

const log = logger('presence');

/** Discord truncates channel status well before this; the limit is a guard, not a target. */
const MAX_STATUS = 500;

let lastActivity: string | null = null;
const lastStatusByChannel = new Map<string, string>();
/** Channels we have already been refused on, so we stop asking every few seconds. */
const statusDenied = new Set<string>();
let timer: NodeJS.Timeout | undefined;

/**
 * What the bot should look like from inside Discord.
 *
 * Two surfaces, both cheap: the bot's own activity ("Listening to ..."), and the voice channel's
 * status line, which Discord shows next to the channel name for everyone in the server. Between
 * them, nobody has to open the control panel or run a slash command to find out what is playing.
 *
 * Both are driven from the same string, which prefers the actual track over the application name
 * whenever the host could tell us one. Each surface is independently toggleable from the panel.
 */
function describeSession(): string | null {
  const sessions = allSessions();
  if (sessions.length === 0) return null;

  const track = describeTrack(nowPlaying());
  if (track) return track;

  // More than one guild is unusual but legal; name the busiest thing rather than inventing a list.
  const labels = sessions.map((session) => session.label);
  return labels.length === 1 ? labels[0]! : `${labels.length} streams`;
}

async function applyActivity(client: Client, description: string | null): Promise<void> {
  if (!client.isReady()) return;

  const wanted = description ?? '';
  if (wanted === lastActivity) return;
  lastActivity = wanted;

  try {
    if (!description) {
      // Clearing means presenting no activities at all, which is a setPresence concern rather
      // than something setActivity can express.
      client.user.setPresence({ activities: [] });
      return;
    }
    client.user.setActivity({ name: description, type: ActivityType.Listening });
  } catch (error) {
    log.debug('could not update bot activity', error);
  }
}

/**
 * Writes the voice channel's status line.
 *
 * discord.js has no typed helper for this endpoint yet, so it goes through the REST client
 * directly. It needs the Set Voice Channel Status permission, which is missing from most older
 * invite URLs - hence the deny-list: a 403 is a permanent answer for that channel, and retrying it
 * on every poll would just fill the log.
 */
async function applyChannelStatus(client: Client, channelId: string, status: string): Promise<void> {
  if (statusDenied.has(channelId)) return;
  const text = status.slice(0, MAX_STATUS);
  if (lastStatusByChannel.get(channelId) === text) return;
  lastStatusByChannel.set(channelId, text);

  try {
    await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: text } });
  } catch (error) {
    const code = (error as { status?: number }).status;
    if (code === 403 || code === 401) {
      statusDenied.add(channelId);
      log.info(
        'no permission to set the voice channel status; re-invite the bot with ' +
          '"Set Voice Channel Status" to show the track on the channel itself',
        { channel: channelId },
      );
    } else {
      log.debug('could not set the voice channel status', error);
    }
    lastStatusByChannel.delete(channelId);
  }
}

async function wipeChannelStatus(client: Client, channelId: string): Promise<void> {
  if (statusDenied.has(channelId)) return;
  if (lastStatusByChannel.get(channelId) === '') return;
  lastStatusByChannel.set(channelId, '');
  try {
    await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: '' } });
  } catch (error) {
    lastStatusByChannel.delete(channelId);
    log.debug('could not clear the voice channel status', error);
  }
}

/** Clears a channel's status when the bot leaves, so it does not linger after the music stops. */
export async function clearChannelStatus(client: Client, channelId: string): Promise<void> {
  lastStatusByChannel.delete(channelId);
  if (statusDenied.has(channelId)) return;
  try {
    await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: '' } });
  } catch (error) {
    log.debug('could not clear the voice channel status', error);
  }
}

/** Pushes the current state to Discord immediately, outside the poll cadence. */
export async function refreshPresence(client: Client): Promise<void> {
  const description = describeSession();
  await applyActivity(client, config.presence.activity ? description : null);

  const sessions = allSessions();
  await Promise.allSettled(
    sessions.map(async (session) => {
      if (!config.presence.channelStatus) {
        await wipeChannelStatus(client, session.channelId);
        return;
      }
      if (!description) {
        await wipeChannelStatus(client, session.channelId);
        return;
      }
      await applyChannelStatus(
        client,
        session.channelId,
        `🎧 ${describeTrack(nowPlaying()) ?? session.label}`,
      );
    }),
  );
}

/**
 * Polls rather than reacting to every state change, because both endpoints are rate limited and a
 * track can change several times a second while someone scrubs. Five seconds is well inside what a
 * person reads as "live" and well outside what Discord objects to.
 *
 * The timer always runs so Setup / Stream toggles take effect without restarting the bot; each
 * apply path no-ops when its flag is off.
 */
export function startPresence(client: Client): () => void {
  if (timer) return () => undefined;

  timer = setInterval(() => void refreshPresence(client).catch(() => undefined), 5_000);
  timer.unref();
  void refreshPresence(client).catch(() => undefined);
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
