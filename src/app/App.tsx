import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ChevronLeft, ChevronRight, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat2, ListPlus, Volume2, Cast, Heart, MoreVertical } from "lucide-react";
import { motion } from "motion/react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { App as CapacitorApp } from "@capacitor/app";
import { MediaSession } from "@capgo/capacitor-media-session";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface MediaStorePlugin {
  getAudioFiles(): Promise<{ tracks: { url: string; title?: string; artist?: string; album?: string; duration?: number }[] }>;
}

const MediaStore = registerPlugin<MediaStorePlugin>("MediaStore");

const FONT_DISPLAY = "Space Grotesk, sans-serif";
const FONT_BODY = "Inter, sans-serif";
const FONT_MONO = "JetBrains Mono, monospace";

const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
  "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock",
  "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack",
  "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance",
  "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
  "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
  "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic",
  "Pop-Folk", "Pop/Jazz", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
  "Psychadelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acapella", "Euro-House",
  "Dance Hall", "Goa", "Drum & Bass", "Club-House", "Hardcore", "Terror", "Indie", "BritPop",
  "Afro-Punk", "Polsk Punk", "Beat", "Christian Gangsta Rap", "Heavy Metal", "Black Metal",
  "Crossover", "Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal",
  "Anime", "Jpop", "Synthpop", "Abstract", "Art Rock", "Baroque", "Bhangra", "Big Beat",
  "Breakbeat", "Chillout", "Downtempo", "Dub", "EBM", "Eclectic", "Electro", "Electroclash",
  "Emo", "Experimental", "Garage", "Global", "IDM", "Illbient", "Industro-Goth", "Jam Band",
  "Krautrock", "Leftfield", "Lounge", "Math Rock", "New Romantic", "Nu-Breakz", "Post-Punk",
  "Post-Rock", "Psytrance", "Shoegaze", "Space Rock", "Trop Rock", "World Music", "Neoclassical",
  "Audiobook", "Audio Theatre", "Neue Deutsche Welle", "Podcast", "Indie Rock", "G-Funk", "Dubstep",
  "Garage Rock", "Psybient",
];

function parseTcon(raw: string): string {
  const trimmed = raw.trim();
  const parenMatch = trimmed.match(/^\((\d+)\)$/);
  if (parenMatch) {
    const idx = parseInt(parenMatch[1], 10);
    if (idx >= 0 && idx < ID3V1_GENRES.length) return ID3V1_GENRES[idx];
  }
  return trimmed.replace(/\0/g, "").split("/")[0].trim() || trimmed;
}

// ── Streaming ID3v2 parser (no Range requests needed — works with Capacitor local server) ──
async function extractId3Metadata(fileUrl: string): Promise<{
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  artBase64: string | null;
  artMime: string | null;
}> {
  const NULL_RESULT = { title: null, artist: null, album: null, genre: null, artBase64: null, artMime: null };
  try {
    const MAX_READ = 600 * 1024; // 600KB — enough for any ID3 header + cover art
    const response = await fetch(fileUrl);
    if (!response.ok || !response.body) return NULL_RESULT;

    // Read only MAX_READ bytes using the streaming reader, then cancel the stream.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    while (bytesRead < MAX_READ) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      bytesRead += value.byteLength;
    }
    reader.cancel().catch(() => { });

    // Merge chunks into a single buffer
    const buf = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
    const view = new DataView(buf.buffer);

    // Check ID3v2 magic: 0x49 0x44 0x33 ("ID3")
    if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return NULL_RESULT;

    const majorVersion = buf[3]; // 3 = ID3v2.3, 4 = ID3v2.4
    const flags = buf[5];
    const hasExtHeader = (flags & 0x40) !== 0;

    // Syncsafe integer for tag size (bytes 6-9)
    const tagSize =
      ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) |
      ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);

    let pos = 10;
    // Skip extended header if present
    if (hasExtHeader) {
      const extSize = majorVersion === 4
        ? ((buf[pos] & 0x7F) << 21) | ((buf[pos + 1] & 0x7F) << 14) | ((buf[pos + 2] & 0x7F) << 7) | (buf[pos + 3] & 0x7F)
        : view.getUint32(pos);
      pos += extSize;
    }

    const endPos = Math.min(10 + tagSize, buf.length);
    let title: string | null = null;
    let artist: string | null = null;
    let album: string | null = null;
    let genre: string | null = null;
    let artBase64: string | null = null;
    let artMime: string | null = null;

    const readFrameSize = (p: number) =>
      majorVersion >= 4
        ? ((buf[p] & 0x7F) << 21) | ((buf[p + 1] & 0x7F) << 14) | ((buf[p + 2] & 0x7F) << 7) | (buf[p + 3] & 0x7F)
        : view.getUint32(p);

    const decodeText = (data: Uint8Array): string => {
      if (data.length === 0) return '';
      const enc = data[0];
      const content = data.slice(1);
      
      if (enc === 1 || enc === 2) {
        // UTF-16
        const hasBOM = content.length >= 2 && ((content[0] === 0xFF && content[1] === 0xFE) || (content[0] === 0xFE && content[1] === 0xFF));
        
        let isBigEndian = false;
        if (hasBOM) {
          isBigEndian = content[0] === 0xFE && content[1] === 0xFF;
        } else {
          // No BOM provided. Heuristic: Check if null bytes are on even indices (Big Endian) or odd indices (Little Endian)
          let evenNulls = 0;
          let oddNulls = 0;
          for (let i = 0; i < Math.min(content.length, 20); i++) {
            if (content[i] === 0) {
              if (i % 2 === 0) evenNulls++;
              else oddNulls++;
            }
          }
          isBigEndian = evenNulls > oddNulls;
        }

        try {
          const decoder = new TextDecoder(isBigEndian ? 'utf-16be' : 'utf-16le');
          return decoder.decode(hasBOM ? content.slice(2) : content).replace(/\0/g, '').trim();
        } catch { return ''; }
      }
      
      if (enc === 3) {
        // UTF-8
        try { return new TextDecoder('utf-8').decode(content).replace(/\0/g, '').trim(); } catch { return ''; }
      }

      // Default (enc === 0) is ISO-8859-1 (Latin-1)
      try { return new TextDecoder('iso-8859-1').decode(content).replace(/\0/g, '').trim(); } catch { return ''; }
    };

    while (pos + 10 < endPos) {
      const frameId = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      if (frameId === '\0\0\0\0') break; // padding
      const frameSize = readFrameSize(pos + 4);
      if (frameSize <= 0 || frameSize > endPos - pos - 10) break;

      const frameData = buf.slice(pos + 10, pos + 10 + frameSize);

      if (frameId === 'TIT2' && !title) title = decodeText(frameData);
      if (frameId === 'TPE1' && !artist) artist = decodeText(frameData);
      if (frameId === 'TALB' && !album) album = decodeText(frameData);
      if (frameId === 'TCON' && !genre) genre = parseTcon(decodeText(frameData));

      if (frameId === 'APIC' && !artBase64) {
        let ap = 1; // skip encoding byte
        // Read null-terminated MIME type
        let mime = '';
        while (ap < frameData.length && frameData[ap] !== 0) mime += String.fromCharCode(frameData[ap++]);
        ap++; // skip null terminator
        ap++; // skip picture type byte
        // Skip description (null-terminated, UTF-16 has double null)
        const enc = frameData[0];
        if (enc === 1 || enc === 2) {
          while (ap + 1 < frameData.length && !(frameData[ap] === 0 && frameData[ap + 1] === 0)) ap += 2;
          ap += 2;
        } else {
          while (ap < frameData.length && frameData[ap] !== 0) ap++;
          ap++;
        }
        const imgBytes = frameData.slice(ap);
        if (imgBytes.length > 0) {
          let binary = '';
          for (let b = 0; b < imgBytes.length; b++) binary += String.fromCharCode(imgBytes[b]);
          artBase64 = btoa(binary);
          artMime = mime || 'image/jpeg';
        }
      }

      pos += 10 + frameSize;
      if (title && artist && album && artBase64 && genre) break;
    }
    return { title, artist, album, genre, artBase64, artMime };
  } catch (e) {
    return { title: null, artist: null, album: null, genre: null, artBase64: null, artMime: null };
  }
}

type Theme = "silver" | "black";
type Screen =
  | "home"
  | "music"
  | "settings"
  | "nowplaying"
  | "coverflow"
  | "allsongs"
  | "playlists"
  | "playlistSongs"
  | "artists"
  | "artistSongs"
  | "albums"
  | "albumSongs"
  | "genres"
  | "genreSongs"
  | "editSong";

interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  art: string;
  genre?: string;
  url?: string;
  localPath?: string;
  artLocalPath?: string; // stable file:// URI for cover art saved in app data dir
  hasExtractedArt?: boolean;
}

function guessTrackGenre(track: Track): string {
  const haystack = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/jazz|swing|bebop/, "Jazz"],
    [/rock|metal|punk|grunge/, "Rock"],
    [/electronic|techno|house|edm|trance|dubstep/, "Electronic"],
    [/hip.?hop|rap|trap/, "Hip-Hop"],
    [/classical|orchestra|symphony|opera/, "Classical"],
    [/country|bluegrass|honky/, "Country"],
    [/folk|acoustic|singer.?songwriter/, "Acoustic"],
    [/pop|dance|disco/, "Pop"],
    [/r&b|soul|funk/, "R&B"],
    [/ambient|lo.?fi|chill/, "Lo-Fi"],
  ];
  for (const [pattern, genre] of rules) {
    if (pattern.test(haystack)) return genre;
  }
  return "Local Audio";
}

function getTrackGenre(track: Track): string {
  return track.genre || guessTrackGenre(track);
}

// No demo tracks — the app uses songs from the device's music library.
const DEFAULT_TRACKS: Track[] = [];

// Safe placeholder used as the initial currentTrack before any library is loaded.
const EMPTY_TRACK: Track = {
  id: -1,
  title: "No Songs Yet",
  artist: "Tap \"Scan Music Library\" to add songs",
  album: "",
  duration: 0,
  art: "local_music_placeholder",
};

// ── Edit Song Screen (extracted to avoid hooks-in-switch violation) ─
interface EditSongScreenProps {
  editingTrack: Track;
  tracks: Track[];
  currentTrack: Track;
  t: ThemeConfig;
  getTrackGenre: (track: Track) => string;
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>;
  setCurrentTrack: React.Dispatch<React.SetStateAction<Track>>;
  saveTracks: (tracks: Track[]) => void;
  goBack: () => void;
}

function EditSongScreen({ editingTrack, tracks, currentTrack, t, setTracks, setCurrentTrack, saveTracks, goBack }: EditSongScreenProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const artistRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const genreRef = useRef<HTMLInputElement>(null);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);

  const handleSave = () => {
    const title = titleRef.current?.value.trim() || editingTrack.title;
    const artist = artistRef.current?.value.trim() || editingTrack.artist;
    const album = albumRef.current?.value.trim() || editingTrack.album;
    const genre = genreRef.current?.value.trim() || getTrackGenre(editingTrack);
    const lyrics = lyricsRef.current?.value.trim() || "";

    const updatedTracks = tracks.map((tr) => {
      if (tr.id === editingTrack.id) {
        const updated = { ...tr, title, artist, album, genre, lyrics };
        if (currentTrack.id === tr.id) {
          setCurrentTrack(updated);
        }
        return updated;
      }
      return tr;
    });

    setTracks(updatedTracks);
    saveTracks(updatedTracks);
    goBack();
    alert("Metadata updated successfully!");
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden select-none" style={{ backgroundColor: t.bg }}>
      <div
        className="flex items-center px-4 pt-4 pb-3 flex-shrink-0 select-none"
        style={{ borderBottom: `1px solid ${t.divider}` }}
      >
        <button
          onClick={goBack}
          className="flex items-center gap-1 mr-3 transition-opacity active:opacity-60"
          style={{ color: t.accent }}
        >
          <ChevronLeft size={22} strokeWidth={2.5} />
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500, color: t.accent }}>Back</span>
        </button>
        <h1
          className="flex-1 text-center truncate pr-8"
          style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, color: t.fg, letterSpacing: "-0.3px" }}
        >
          Edit Song Info
        </h1>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: "none" }}>
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider mb-1.5" style={{ color: t.muted }}>Song Title</label>
          <input type="text" defaultValue={editingTrack.title} ref={titleRef}
            className="w-full px-3 py-2 rounded-lg text-sm border focus:outline-none"
            style={{ backgroundColor: t.tertiary, color: t.fg, borderColor: t.border }} />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider mb-1.5" style={{ color: t.muted }}>Artist</label>
          <input type="text" defaultValue={editingTrack.artist} ref={artistRef}
            className="w-full px-3 py-2 rounded-lg text-sm border focus:outline-none"
            style={{ backgroundColor: t.tertiary, color: t.fg, borderColor: t.border }} />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider mb-1.5" style={{ color: t.muted }}>Album</label>
          <input type="text" defaultValue={editingTrack.album} ref={albumRef}
            className="w-full px-3 py-2 rounded-lg text-sm border focus:outline-none"
            style={{ backgroundColor: t.tertiary, color: t.fg, borderColor: t.border }} />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider mb-1.5" style={{ color: t.muted }}>Genre</label>
          <input type="text" defaultValue={getTrackGenre(editingTrack)} ref={genreRef}
            className="w-full px-3 py-2 rounded-lg text-sm border focus:outline-none"
            style={{ backgroundColor: t.tertiary, color: t.fg, borderColor: t.border }} />
        </div>
        <div className="mb-5">
          <label className="block text-xs font-bold uppercase tracking-wider mb-1.5" style={{ color: t.muted }}>Lyrics</label>
          <textarea defaultValue={(editingTrack as any).lyrics || ""} ref={lyricsRef} rows={4}
            className="w-full px-3 py-2 rounded-lg text-sm border focus:outline-none resize-none"
            style={{ backgroundColor: t.tertiary, color: t.fg, borderColor: t.border }} />
        </div>
        <button
          onClick={handleSave}
          className="w-full py-3 rounded-xl text-sm font-bold text-center active:scale-[0.98] transition-all"
          style={{ backgroundColor: t.accent, color: t.highlightText }}
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}

const GrainOverlay = ({ id }: { id: string | number }) => (
  <svg
    className="absolute inset-0 w-full h-full pointer-events-none rounded-[inherit]"
    style={{ opacity: 0.05 }}
    aria-hidden="true"
  >
    <defs>
      <filter id={`grain-${id}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch" />
      </filter>
    </defs>
    <rect width="100%" height="100%" filter={`url(#grain-${id})`} />
  </svg>
);

const Artwork = ({ track, className, style }: { track: Track; className?: string; style?: React.CSSProperties }) => {
  if (track.art && track.art !== "local_music_placeholder") {
    return <img src={track.art} alt={track.album} className={className} style={style} />;
  }

  const getGradient = (text: string) => {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h1 = Math.abs(hash % 360);
    const h2 = (h1 + 60) % 360;
    return `linear-gradient(135deg, hsl(${h1}, 80%, 45%) 0%, hsl(${h2}, 85%, 25%) 100%)`;
  };

  return (
    <div
      className={`relative flex flex-col items-center justify-center text-center p-6 ${className || ""}`}
      style={{
        ...style,
        background: getGradient(track.title),
        color: '#FFFFFF'
      }}
    >
      <GrainOverlay id={track.id} />
      <div className="font-extrabold text-[52px] tracking-tight opacity-40 select-none font-sans">
        ♫
      </div>
      <p className="font-bold text-[18px] mt-4 line-clamp-2 px-2" style={{ fontFamily: FONT_DISPLAY }}>
        {track.title}
      </p>
      <p className="text-[12px] opacity-75 mt-1 line-clamp-1" style={{ fontFamily: FONT_BODY }}>
        {track.artist}
      </p>
    </div>
  );
};

interface ThemeConfig {
  bg: string;
  fg: string;
  secondary: string;
  tertiary: string;
  highlight: string;
  highlightText: string;
  muted: string;
  border: string;
  accent: string;
  artShadow: string;
  toggleOn: string;
  toggleOff: string;
  thumbBg: string;
  name: string;
  isDark: boolean;
  deviceBg: string;
  divider: string;
}

const THEMES: Record<Theme, ThemeConfig> = {
  silver: {
    bg: "#F2F2F7",
    fg: "#1D1D1F",
    secondary: "#FFFFFF",
    tertiary: "#E5E5EA",
    highlight: "#007AFF",
    highlightText: "#FFFFFF",
    muted: "#6E6E73",
    border: "rgba(0,0,0,0.1)",
    accent: "#007AFF",
    artShadow: "0 24px 80px -12px rgba(0,0,0,0.35)",
    toggleOn: "#34C759",
    toggleOff: "#C7C7CC",
    thumbBg: "#FFFFFF",
    name: "Classic Silver",
    isDark: false,
    deviceBg: "#E8E8ED",
    divider: "rgba(0,0,0,0.08)",
  },
  black: {
    bg: "#000000",
    fg: "#FFFFFF",
    secondary: "#1C1C1E",
    tertiary: "#2C2C2E",
    highlight: "#FFFFFF",
    highlightText: "#000000",
    muted: "#8E8E93",
    border: "rgba(255,255,255,0.1)",
    accent: "#FFFFFF",
    artShadow: "0 20px 60px -10px rgba(0,0,0,0.9)",
    toggleOn: "#34C759",
    toggleOff: "#3A3A3C",
    thumbBg: "#FFFFFF",
    name: "Space Black",
    isDark: true,
    deviceBg: "#1A1A1A",
    divider: "rgba(255,255,255,0.06)",
  },
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const TIME_STYLE: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontVariantNumeric: "tabular-nums",
};

// ── VU Meter (radial arc around album art) ──
function VUMeter({
  analyser,
  active,
  accentColor,
  mutedColor,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  accentColor: string;
  mutedColor: string;
}) {
  const [bars, setBars] = useState<number[]>(new Array(32).fill(0));
  const smoothedData = useRef<number[]>(new Array(32).fill(0));
  const reqRef = useRef<number>(0);

  useEffect(() => {
    if (!analyser || !active) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);
      let updated = false;
      const newBars = [...smoothedData.current];
      for (let i = 0; i < 32; i++) {
        const value = dataArray[i * 2] || 0;
        const target = (value / 255) * 45;
        newBars[i] = newBars[i] * 0.7 + target * 0.3;
        if (Math.abs(newBars[i] - smoothedData.current[i]) > 0.5) updated = true;
      }
      smoothedData.current = newBars;
      if (updated) setBars(newBars);
      reqRef.current = requestAnimationFrame(draw);
    };
    reqRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(reqRef.current);
  }, [analyser, active]);

  return (
    <svg width="400" height="400" viewBox="0 0 400 400" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 0, pointerEvents: "none" }}>
      <g transform="translate(200,200)">
        {bars.map((h, i) => {
          const angle = (i * 360) / 32;
          return (
            <g key={i} transform={`rotate(${angle}) translate(0, -170)`}>
              <rect x="-2" y="0" width="4" height="6" rx="2" fill={mutedColor} opacity={0.35} />
              <rect x="-2" y="-2" width="4" height={Math.max(0, h)} rx="2" fill={accentColor} transform="scale(1, -1)" />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function Toggle({ on, onToggle, theme }: { on: boolean; onToggle: () => void; theme: ThemeConfig }) {
  return (
    <button
      onClick={onToggle}
      className="relative flex-shrink-0 rounded-full transition-all duration-300 focus:outline-none"
      style={{
        width: 51,
        height: 31,
        backgroundColor: on ? theme.toggleOn : theme.toggleOff,
      }}
    >
      <div
        className="absolute top-[2px] rounded-full transition-all duration-300"
        style={{
          width: 27,
          height: 27,
          backgroundColor: theme.thumbBg,
          left: on ? "calc(100% - 29px)" : "2px",
          boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}

// ── Virtualized Track List for 10k+ Songs ──
interface VirtualizedTrackListProps {
  tracks: Track[];
  renderItem: (track: Track, index: number) => React.ReactNode;
}

function VirtualizedTrackList({ tracks, renderItem }: VirtualizedTrackListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  
  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72, // Approximates height of SongTile (16px py-3 + icon + text)
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto w-full" style={{ scrollbarWidth: "none" }}>
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderItem(tracks[virtualItem.index], virtualItem.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

  // ── Status Bar ──────────────────────────────────────────────
  const StatusBar = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
  return (
    <div
      className="flex items-center justify-between px-6 pt-3 pb-1 flex-shrink-0 select-none"
      style={{ color: t.fg }}
    >
      <span className="text-[15px] font-semibold" style={{ ...TIME_STYLE, fontSize: 15 }}>
        {timeStr}
      </span>
      <div className="flex items-center gap-1.5">
        <div className="flex items-end gap-[2px] h-3">
          {[3, 5, 7, 9, 11].map((h, i) => (
            <div
              key={i}
              className="w-[3px] rounded-sm transition-all"
              style={{
                height: h,
                backgroundColor: i < 4 ? t.fg : t.border,
                opacity: i < 4 ? 1 : 0.4,
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-0.5 ml-1">
          <div
            className="rounded-sm"
            style={{
              width: 25,
              height: 12,
              border: `1.5px solid ${t.fg}`,
              padding: 2,
              opacity: 0.9,
            }}
          >
            <div
              className="h-full rounded-[1px]"
              style={{ width: "75%", backgroundColor: t.fg }}
            />
          </div>
          <div
            className="rounded-[1px]"
            style={{ width: 2, height: 6, backgroundColor: t.fg, opacity: 0.6 }}
          />
        </div>
      </div>
    </div>
  );
}

  // ── Home Screen ─────────────────────────────────────────────
  const HomeScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
      {/* Slideshow top half */}
      <div className="relative overflow-hidden" style={{ height: "48%" }}>
        {tracks.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13"></path>
              <circle cx="6" cy="18" r="3"></circle>
              <circle cx="18" cy="16" r="3"></circle>
            </svg>
            <p style={{ marginTop: 16, color: "rgba(255,255,255,0.4)", fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 500 }}>
              Library is empty
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); scanStorage(false); }}
              className="mt-6 px-6 py-2.5 rounded-full font-semibold text-sm transition-all"
              style={{ backgroundColor: "#FFFFFF", color: "#000000" }}
            >
              Scan Device for Music
            </button>
          </div>
        ) : (
          tracks.map((track, i) => (
            <div
              key={track.id}
              className="absolute inset-0 transition-opacity duration-1000"
              style={{ opacity: i === slideIndex ? 1 : 0 }}
            >
              {track.art === "local_music_placeholder" ? (
                <Artwork track={track} className="w-full h-full object-cover" style={{ filter: "brightness(0.85)" }} />
              ) : (
                <img
                  src={track.art}
                  alt={track.album}
                  className="w-full h-full object-cover"
                  style={{ transform: "scale(1.08)", filter: "brightness(0.85)" }}
                />
              )}
            </div>
          ))
        )}

        {/* Gradient overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: t.isDark
              ? "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.5) 100%)"
              : "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(242,242,247,0.8) 100%)",
          }}
        />
        {/* Album info overlay */}
        {tracks.length > 0 && (
          <div className="absolute bottom-4 left-5 right-5 pointer-events-none">
            <p
              className="text-xs uppercase tracking-widest mb-1"
              style={{ color: "rgba(255,255,255,0.7)", fontFamily: "Inter, sans-serif", fontSize: 11 }}
            >
              {tracks[slideIndex]?.album || ""}
            </p>
            <p
              className="font-bold text-white leading-none"
              style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700 }}
            >
              {tracks[slideIndex]?.artist || ""}
            </p>
          </div>
        )}
        {/* Slide dots */}
        {tracks.length > 0 && (
          <div className="absolute bottom-4 right-5 flex gap-1.5 items-center pointer-events-none">
            {tracks.map((_, i) => (
              <div
                key={i}
                className="rounded-full transition-all duration-500"
                style={{
                  width: i === slideIndex ? 14 : 5,
                  height: 5,
                  backgroundColor: i === slideIndex ? "#FFFFFF" : "rgba(255,255,255,0.4)",
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 1, backgroundColor: t.border, flexShrink: 0 }} />

      {/* Menu list */}
      <div
        ref={menuRef}
        className="flex-1 flex flex-col select-none"
        style={{ backgroundColor: t.bg }}
        onPointerDown={(e) => {
          dragging.current = true;
          updateSelection(e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) updateSelection(e.clientY);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
        }}
        onPointerLeave={() => { dragging.current = false; }}
      >
        {homeMenuItems.map((item, i) => {
          const isActive = i === activeIndex;
          return (
            <div
              key={item.label}
              className="flex items-center justify-between px-5 cursor-pointer transition-colors duration-100"
              style={{
                flex: 1,
                backgroundColor: isActive ? t.highlight : "transparent",
                borderBottom: i < homeMenuItems.length - 1 ? `1px solid ${t.divider}` : "none",
              }}
              onClick={() => { setActiveIndex(i); item.action(); }}
            >
              <span
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 20,
                  fontWeight: 600,
                  color: isActive ? t.highlightText : t.fg,
                  letterSpacing: "-0.3px",
                }}
              >
                {item.label}
              </span>
              <ChevronRight
                size={18}
                color={isActive ? t.highlightText : t.muted}
                strokeWidth={2.5}
              />
            </div>
          );
        })}
      </div>

      {/* Drag hint */}
      <div className="flex justify-center py-2 flex-shrink-0" style={{ backgroundColor: t.bg }}>
        <p style={{ fontSize: 10, color: t.muted, fontFamily: "Inter, sans-serif", letterSpacing: "0.02em" }}>
          drag to select · tap to open
        </p>
      </div>
    </div>
  );
}

  // ── List Screen (Music / generic) ───────────────────────────
  const ListScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
  const { title, items } = props;
  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
      {/* Header */}
      <div
        className="flex items-center px-4 pt-2 pb-3 flex-shrink-0"
        style={{ borderBottom: `1px solid ${t.border}` }}
      >
        <button
          onClick={goBack}
          className="flex items-center gap-1 mr-3 transition-opacity active:opacity-60"
          style={{ color: t.accent }}
        >
          <ChevronLeft size={22} strokeWidth={2.5} />
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500, color: t.accent }}>
            Back
          </span>
        </button>
        <h1
          className="flex-1 text-center"
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 18,
            fontWeight: 700,
            color: t.fg,
            letterSpacing: "-0.3px",
          }}
        >
          {title}
        </h1>
        <div style={{ width: 60 }} />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
        {items.map((item, i) => (
          <button
            key={item.label}
            onClick={item.action}
            className="w-full flex items-center justify-between px-5 text-left transition-opacity active:opacity-60"
            style={{
              height: 52,
              backgroundColor: "transparent",
              borderBottom: `1px solid ${t.divider}`,
            }}
          >
            <span
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: 17,
                fontWeight: 500,
                color: t.fg,
              }}
            >
              {item.label}
            </span>
            <ChevronRight size={16} color={t.muted} strokeWidth={2} />
          </button>
        ))}
      </div>
    </div>
  );
}

  // ── Settings Screen ─────────────────────────────────────────
  const SettingsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
    const deviceColors = [
      { name: "Silver", bg: "#E8E8ED", border: "#9D9DA5" },
      { name: "Black", bg: "#1A1A1A", border: "#4A4A4A" },
      { name: "U2", bg: "#8B0000", border: "#5C0000" },
      { name: "White", bg: "#F8F8F8", border: "#C8C8CC" },
    ];

    return (
      <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
        {/* Header */}
        <div
          className="flex items-center px-4 pt-2 pb-3 flex-shrink-0"
          style={{ borderBottom: `1px solid ${t.border}` }}
        >
          <button
            onClick={goBack}
            className="flex items-center gap-1 mr-3 transition-opacity active:opacity-60"
            style={{ color: t.accent }}
          >
            <ChevronLeft size={22} strokeWidth={2.5} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500, color: t.accent }}>
              Back
            </span>
          </button>
          <h1
            className="flex-1 text-center"
            style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, color: t.fg, letterSpacing: "-0.3px" }}
          >
            Settings
          </h1>
          <div style={{ width: 60 }} />
        </div>

        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
          {settingsMenuItems.map((item, i) => (
            <div
              key={item.label}
              className="flex items-center justify-between px-5"
              style={{
                minHeight: item.type === "color" ? 72 : 52,
                borderBottom: `1px solid ${t.divider}`,
                backgroundColor: "transparent",
              }}
            >
              <span
                style={{ fontFamily: FONT_DISPLAY, fontSize: 17, fontWeight: 500, color: t.fg }}
              >
                {item.label}
              </span>

              {item.type === "toggle" && (
                <Toggle on={item.value!} onToggle={item.onToggle!} theme={t} />
              )}

              {item.type === "crossfade" && (
                <button
                  onClick={() => {
                    setCrossfadeDuration(prev => {
                      if (prev === 0) return 1000;
                      if (prev === 1000) return 2500;
                      if (prev === 2500) return 5000;
                      return 0;
                    });
                  }}
                  className="px-3 py-1.5 rounded-full text-sm font-medium transition-opacity active:opacity-60"
                  style={{ backgroundColor: `${t.accent}1A`, color: t.accent, fontFamily: "Inter, sans-serif" }}
                >
                  {crossfadeDuration === 0 ? "Off" : `${crossfadeDuration / 1000}s`}
                </button>
              )}

              {item.type === "theme" && (
                <div className="flex gap-3 items-center">
                  <button
                    onClick={() => setTheme("silver")}
                    className="flex flex-col items-center gap-1 transition-opacity active:opacity-60"
                  >
                    <div
                      className="rounded-full"
                      style={{
                        width: 28,
                        height: 28,
                        backgroundColor: "#E8E8ED",
                        border: `2px solid ${theme === "silver" ? t.accent : t.border}`,
                        boxShadow: theme === "silver" ? `0 0 0 2px ${t.accent}40` : "none",
                      }}
                    />
                    <span style={{ fontSize: 9, color: t.muted, fontFamily: "Inter, sans-serif" }}>Silver</span>
                  </button>
                  <button
                    onClick={() => setTheme("black")}
                    className="flex flex-col items-center gap-1 transition-opacity active:opacity-60"
                  >
                    <div
                      className="rounded-full"
                      style={{
                        width: 28,
                        height: 28,
                        backgroundColor: "#1A1A1A",
                        border: `2px solid ${theme === "black" ? t.accent : t.border}`,
                        boxShadow: theme === "black" ? `0 0 0 2px ${t.accent}40` : "none",
                      }}
                    />
                    <span style={{ fontSize: 9, color: t.muted, fontFamily: "Inter, sans-serif" }}>Black</span>
                  </button>
                </div>
              )}

              {item.type === "color" && (
                <div className="flex gap-2.5 items-center">
                  {deviceColors.map((dc) => (
                    <div
                      key={dc.name}
                      className="rounded-full flex flex-col items-center gap-1"
                    >
                      <div
                        className="rounded-full"
                        style={{
                          width: 26,
                          height: 26,
                          backgroundColor: dc.bg,
                          border: `1.5px solid ${dc.border}`,
                        }}
                      />
                      <span style={{ fontSize: 8, color: t.muted, fontFamily: "Inter, sans-serif" }}>
                        {dc.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── Now Playing Screen ──────────────────────────────────────
  const NowPlayingScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
    if (isLandscape) {
      return <CoverFlowScreen {...appProps} />;
    }

    const progressSec = progress * currentTrack.duration;
    const remainSec = currentTrack.duration - progressSec;

    return (
      <div
        className="flex flex-col flex-1 overflow-hidden"
        style={{ backgroundColor: t.isDark ? "#0A0A0A" : "#F2F2F7" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-1 pb-2 flex-shrink-0">
          <button
            onClick={goBack}
            className="flex items-center gap-1 transition-opacity active:opacity-60"
            style={{ color: t.accent }}
          >
            <ChevronLeft size={22} strokeWidth={2.5} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500, color: t.accent }}>
              Back
            </span>
          </button>
          <span
            style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 600, color: t.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}
          >
            Now Playing
          </span>
          <div style={{ width: 60 }} />
        </div>

        {/* Album art */}
        <div className="flex-1 flex items-center justify-center px-8 relative" style={{ minHeight: 0 }}>
          

          <motion.div
            key={currentTrack.id}
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full relative touch-none select-none"
            style={{ maxWidth: 300, aspectRatio: "1/1" }}
            onPointerDown={(e) => {
              volDragRef.current = { startY: e.clientY, startVol: audioRef.current?.volume ?? 1 };
              setVolumeOverlay(audioRef.current?.volume ?? 1);
            }}
            onPointerMove={(e) => {
              if (volDragRef.current && audioRef.current) {
                const dy = volDragRef.current.startY - e.clientY;
                // e.g. 150px drag = 100% volume change
                let newVol = volDragRef.current.startVol + (dy / 150);
                newVol = Math.max(0, Math.min(1, newVol));

                // Haptic tick if volume changes by roughly 5% (0.05)
                const step = Math.floor(newVol * 20);
                const oldStep = Math.floor(audioRef.current.volume * 20);
                if (step !== oldStep) {
                  Haptics.impact({ style: ImpactStyle.Light }).catch(() => { });
                }

                audioRef.current.volume = newVol;
                setVolume(newVol);
                setVolumeOverlay(newVol);
              }
            }}
            onPointerUp={() => {
              volDragRef.current = null;
              setTimeout(() => { if (!volDragRef.current) setVolumeOverlay(null); }, 800);
            }}
            onPointerLeave={() => {
              volDragRef.current = null;
              setTimeout(() => { if (!volDragRef.current) setVolumeOverlay(null); }, 800);
            }}
          >
            {currentTrack.art === "local_music_placeholder" ? (
              <Artwork
                track={currentTrack}
                className="w-full h-full rounded-2xl pointer-events-none"
                style={{
                  width: '100%',
                  height: '100%',
                  aspectRatio: "1/1",
                  borderRadius: '1rem',
                  boxShadow: t.artShadow
                }}
              />
            ) : (
              <img
                src={currentTrack.art}
                alt={currentTrack.album}
                className="w-full h-full object-cover rounded-2xl pointer-events-none"
                style={{ boxShadow: t.artShadow }}
              />
            )}

            {/* Volume Overlay */}
            {volumeOverlay !== null && (
              <div
                className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl pointer-events-none transition-opacity duration-200"
                style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)" }}
              >
                <div className="w-12 h-32 bg-black bg-opacity-40 rounded-full mb-3 relative overflow-hidden border border-white border-opacity-10">
                  <div
                    className="absolute bottom-0 left-0 right-0 bg-white transition-all duration-75"
                    style={{ height: `${volumeOverlay * 100}%` }}
                  />
                </div>
                <span className="text-white font-bold text-2xl" style={{ ...TIME_STYLE, fontSize: 24 }}>
                  {Math.round(volumeOverlay * 100)}%
                </span>
              </div>
            )}
          </motion.div>
        </div>

        {/* Track info + controls */}
        <div
          className="flex-shrink-0 px-6 pt-5 pb-6"
          style={{ backgroundColor: t.isDark ? "#0A0A0A" : "#F2F2F7" }}
        >
          {/* Track info */}
          <div className="flex items-start justify-between mb-5">
            <div className="flex-1 mr-3" style={{ minWidth: 0 }}>
              <h2
                className="leading-none mb-1 truncate"
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 28,
                  fontWeight: 800,
                  color: t.fg,
                  letterSpacing: "-0.5px",
                }}
              >
                {currentTrack.title}
              </h2>
              <p
                className="truncate"
                style={{ fontFamily: "Inter, sans-serif", fontSize: 15, color: t.muted, fontWeight: 400 }}
              >
                {currentTrack.artist} — {currentTrack.album}
              </p>
            </div>
            <div className="flex items-center gap-4 mt-0.5">
              <button
                onClick={() => {
                  setSelectedOptionTrack(currentTrack);
                  setIsPlaylistSelectOpen(true);
                }}
                className="transition-opacity active:opacity-60"
              >
                <ListPlus size={20} color={t.muted} strokeWidth={2} />
              </button>
              <button
                onClick={() => setShuffle((s) => !s)}
                className="transition-opacity active:opacity-60"
              >
                <Shuffle size={20} color={shuffle ? t.accent : t.muted} strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* Scrubber — pointer events work for both mouse and touch */}
          <div className="mb-2">
            <div
              className="relative cursor-pointer select-none"
              style={{ height: 28, display: 'flex', alignItems: 'center', touchAction: 'none' }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                isSeeking.current = true;
                const rect = e.currentTarget.getBoundingClientRect();
                seekTo((e.clientX - rect.left) / rect.width);
              }}
              onPointerMove={(e) => {
                if (!isSeeking.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                seekTo((e.clientX - rect.left) / rect.width);
              }}
              onPointerUp={() => { isSeeking.current = false; }}
              onPointerCancel={() => { isSeeking.current = false; }}
            >
              {/* Track */}
              <div className="w-full rounded-full relative" style={{ height: 4, backgroundColor: t.tertiary }}>
                {/* Filled portion */}
                <div
                  className="h-full rounded-full"
                  style={{ width: `${progress * 100}%`, backgroundColor: t.accent }}
                />
                {/* Thumb dot */}
                <div
                  className="absolute top-1/2 rounded-full"
                  style={{
                    width: 14, height: 14,
                    backgroundColor: t.fg,
                    left: `calc(${progress * 100}% - 7px)`,
                    top: '50%', transform: 'translateY(-50%)',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                    transition: isSeeking.current ? 'none' : 'left 0.1s linear',
                  }}
                />
              </div>
            </div>
            <div className="flex justify-between" style={{ marginTop: 2 }}>
              <span style={{ ...TIME_STYLE, fontSize: 12, color: t.muted }}>
                {formatTime(progressSec)}
              </span>
              <span style={{ ...TIME_STYLE, fontSize: 12, color: t.muted }}>
                −{formatTime(remainSec)}
              </span>
            </div>
          </div>

          {/* Volume slider */}
          <div className="flex items-center gap-3 mb-2" style={{ opacity: 0.75 }}>
            <span style={{ fontSize: 11, color: t.muted }}>🔈</span>
            <div
              className="flex-1 relative cursor-pointer select-none"
              style={{ height: 24, display: 'flex', alignItems: 'center', touchAction: 'none' }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const rect = e.currentTarget.getBoundingClientRect();
                setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
              }}
              onPointerMove={(e) => {
                if (e.buttons === 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
              }}
            >
              <div className="w-full rounded-full relative" style={{ height: 3, backgroundColor: t.tertiary }}>
                <div className="h-full rounded-full" style={{ width: `${volume * 100}%`, backgroundColor: t.muted }} />
                <div className="absolute rounded-full" style={{
                  width: 12, height: 12,
                  backgroundColor: t.fg,
                  left: `calc(${volume * 100}% - 6px)`,
                  top: '50%', transform: 'translateY(-50%)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                }} />
              </div>
            </div>
            <span style={{ fontSize: 11, color: t.muted }}>🔊</span>
          </div>

          {/* Playback controls */}
          <div className="flex items-center justify-around px-4 mt-6 mb-2">
            <button
              onClick={skipPrev}
              className="transition-opacity active:opacity-50 p-4"
            >
              <SkipBack size={36} color={t.fg} strokeWidth={1.5} fill={t.fg} />
            </button>

            <button
              onClick={() => setIsPlaying((p) => !p)}
              className="transition-all active:scale-95 p-4"
            >
              {isPlaying ? (
                <Pause size={44} color={t.fg} fill={t.fg} strokeWidth={0} />
              ) : (
                <Play size={44} color={t.fg} fill={t.fg} strokeWidth={0} style={{ marginLeft: 4 }} />
              )}
            </button>

            <button
              onClick={skipNext}
              className="transition-opacity active:opacity-50 p-4"
            >
              <SkipForward size={36} color={t.fg} strokeWidth={1.5} fill={t.fg} />
            </button>
          </div>

          {/* Repeat button */}
          <div className="flex justify-center mt-4">
            <button
              onClick={() => setRepeat((r) => !r)}
              className="transition-opacity active:opacity-60"
            >
              <Repeat2 size={18} color={repeat ? t.accent : t.muted} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── Cover Flow Screen ───────────────────────────────────────
  const CoverFlowScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
    const cfTrack = tracks[cflowIndex] || { title: "No Tracks", artist: "Unknown", duration: 0 };

    const duration = cfTrack.duration || 0;
    const isCfTrackPlaying = currentTrack.id === cfTrack.id;
    const progressSec = isCfTrackPlaying ? progress * duration : 0;
    const remainSec = duration - progressSec;

    return (
      <div
        className="flex flex-col flex-1 overflow-hidden select-none"
        style={{ backgroundColor: "#000000" }}
      >
        {/* Header - Hidden in landscape */}
        {!isLandscape && (
          <div className="flex items-center justify-between px-4 pt-1 pb-2 flex-shrink-0">
            <button
              onClick={goBack}
              className="flex items-center gap-1 transition-opacity active:opacity-60"
              style={{ color: "#FFFFFF" }}
            >
              <ChevronLeft size={22} strokeWidth={2.5} />
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500, color: "#FFFFFF" }}>
                Back
              </span>
            </button>
            <span
              style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 600, color: "#6E6E73", letterSpacing: "0.1em", textTransform: "uppercase" }}
            >
              Cover Flow
            </span>
            <div style={{ width: 60 }} />
          </div>
        )}

        {/* Flow stage - Zone 1 */}
        <div
          className="flex-1 flex flex-col"
          style={{
            height: isLandscape ? "60%" : "auto",
            perspective: 1000,
            perspectiveOrigin: "50% 38%",
            cursor: cfIsDragging.current ? "grabbing" : "grab",
            touchAction: "none",
          }}
          onTouchStart={handleCfTouchStart}
          onTouchMove={handleCfTouchMove}
          onTouchEnd={handleCfTouchEnd}
          onMouseDown={handleCfMouseDown}
          onMouseMove={handleCfMouseMove}
          onMouseUp={handleCfMouseUp}
          onMouseLeave={handleCfMouseUp}
        >
          {/* Carousel */}
          <div className="flex-1" style={{ position: "relative" }}>
            <div
              ref={carouselRef}
              style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d" }}
            >
              {tracks.map((track, i) => {
                const preRenderWindow = Math.abs(i - cflowIndex) <= 5;
                if (!preRenderWindow) return null;

                return (
                  <div
                    key={track.id}
                    data-index={i}
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "46%",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      transformStyle: "preserve-3d",
                      willChange: "transform, filter",
                      transform: `translate(-50%, -50%)`,
                      pointerEvents: "auto",
                    }}
                    onPointerUp={(e) => {
                      const totalDrag = Math.abs(cfLastX.current - cfStartX.current);
                      if (totalDrag > 8) return;
                      if (i === cflowIndex) {
                        setCurrentTrack(track);
                        setIsPlaying(true);
                        setProgress(0);
                        if (!isLandscape) navigate("nowplaying");
                      } else {
                        setCflowIndex(i);
                        springToIndex(i, 0);
                        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                      }
                    }}
                  >
                    <div style={{ position: "relative" }}>
                      {track.art === "local_music_placeholder" ? (
                        <Artwork
                          track={track}
                          style={{
                            width: 220,
                            height: 220,
                            borderRadius: 10,
                            boxShadow: i === cflowIndex
                              ? "0 30px 70px -10px rgba(0,0,0,0.95), 0 0 0 0.5px rgba(255,255,255,0.08)"
                              : "0 10px 30px -6px rgba(0,0,0,0.85)",
                          }}
                        />
                      ) : (
                        <img
                          src={track.art}
                          alt={track.album}
                          style={{
                            width: 220,
                            height: 220,
                            objectFit: "cover",
                            borderRadius: 10,
                            boxShadow: i === cflowIndex
                              ? "0 30px 70px -10px rgba(0,0,0,0.95), 0 0 0 0.5px rgba(255,255,255,0.08)"
                              : "0 10px 30px -6px rgba(0,0,0,0.85)",
                            display: "block",
                          }}
                        />
                      )}
                      {/* Reflection */}
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: "100%",
                          height: 75,
                          overflow: "hidden",
                          transform: "scaleY(-1)",
                          opacity: 0.22,
                          borderRadius: "0 0 10px 10px",
                          maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)",
                          WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)",
                        }}
                      >
                        {track.art === "local_music_placeholder" ? (
                          <Artwork track={track} style={{ width: 220, height: 220 }} />
                        ) : (
                          <img
                            src={track.art}
                            alt=""
                            style={{ width: 220, height: 220, objectFit: "cover", display: "block" }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Portrait Track Info (Hidden in landscape) */}
          {!isLandscape && (
            <div
              className="text-center pb-6 pt-10 flex-shrink-0 cursor-pointer"
              onClick={() => {
                setCurrentTrack(cfTrack);
                setIsPlaying(true);
                setProgress(0);
                navigate("nowplaying");
              }}
            >
              <p style={{ fontFamily: FONT_DISPLAY, fontSize: 19, fontWeight: 700, color: "#FFFFFF", letterSpacing: "-0.3px", marginBottom: 3 }}>
                {cfTrack.title}
              </p>
              <p style={{ fontFamily: "Inter, sans-serif", fontSize: 14, color: "#8E8E93" }}>
                {cfTrack.artist}
              </p>
              <div
                className="flex justify-center gap-1.5 mt-4 py-2"
                style={{ touchAction: "none" }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const newIdx = Math.round(pct * (tracks.length - 1));
                  if (newIdx !== cflowIndex) {
                    setCflowIndex(newIdx);
                    springToIndex(newIdx, 0);
                    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                  }
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const newIdx = Math.round(pct * (tracks.length - 1));
                  if (newIdx !== cflowIndex) {
                    setCflowIndex(newIdx);
                    springToIndex(newIdx, 0);
                    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
                  }
                }}
              >
                {tracks.slice(0, Math.min(tracks.length, 80)).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-full transition-all duration-300"
                    style={{
                      width: i === cflowIndex ? 18 : 5,
                      height: 5,
                      backgroundColor: i === cflowIndex ? "#FFFFFF" : "rgba(255,255,255,0.22)",
                    }}
                  />
                ))}
              </div>
              <p style={{ fontFamily: "Inter, sans-serif", fontSize: 11, color: "rgba(255,255,255,0.22)", marginTop: 4 }}>
                swipe to browse · tap center to play
              </p>
            </div>
          )}
        </div>

        {/* Zone 2: The Control Deck (Landscape Only) */}
        {isLandscape && (
          <div className="flex flex-row w-full px-12 items-center" style={{ height: "40%", backgroundColor: "#000000" }}>
            
            {/* Left Column */}
            <div className="flex-1 flex flex-col justify-center" style={{ alignItems: "flex-start" }}>
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: 13, color: "#8E8E93", marginBottom: 6 }}>
                {formatTime(progressSec)} {remainSec > 0 ? `-${formatTime(remainSec)}` : ''}
              </span>
              <p style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 700, color: "#FFFFFF", letterSpacing: "-0.3px", marginBottom: 2 }}>
                {cfTrack.title}
              </p>
              <p style={{ fontFamily: "Inter, sans-serif", fontSize: 16, color: "#CCCCCC", fontWeight: 500 }}>
                {cfTrack.artist}
              </p>
            </div>

            {/* Center Column */}
            <div className="flex-1 flex justify-center items-center gap-8">
              <button onClick={skipPrev} className="transition-opacity active:opacity-50">
                <SkipBack size={32} color="#FFFFFF" strokeWidth={1.5} fill="#FFFFFF" />
              </button>
              <button
                onClick={() => {
                  if (currentTrack.id !== cfTrack.id) {
                    setCurrentTrack(cfTrack);
                    setIsPlaying(true);
                    setProgress(0);
                  } else {
                    setIsPlaying((p) => !p);
                  }
                }}
                className="transition-all active:scale-95"
              >
                {(isPlaying && isCfTrackPlaying) ? (
                  <Pause size={48} color="#FFFFFF" fill="#FFFFFF" strokeWidth={0} />
                ) : (
                  <Play size={48} color="#FFFFFF" fill="#FFFFFF" strokeWidth={0} style={{ marginLeft: 4 }} />
                )}
              </button>
              <button onClick={skipNext} className="transition-opacity active:opacity-50">
                <SkipForward size={32} color="#FFFFFF" strokeWidth={1.5} fill="#FFFFFF" />
              </button>
            </div>

            {/* Right Column */}
            <div className="flex-1 flex justify-end items-center gap-6">
              <Volume2 size={24} color="#8E8E93" />
              <Cast size={24} color="#8E8E93" />
              <Heart size={24} color="#8E8E93" />
              <MoreVertical size={24} color="#8E8E93" />
            </div>
            
          </div>
        )}
      </div>
    );
  };

  // ── Screen Router ───────────────────────────────────────────
  const ScreenHeader = ({ title, onBack, t }: { title: string; onBack: () => void; t: any }) => (
    <div
      className="flex items-center px-4 pt-4 pb-3 flex-shrink-0 select-none"
      style={{ borderBottom: `1px solid ${t.divider}` }}
    >
      <button
        onClick={onBack}
        className="flex items-center gap-1 mr-3 transition-opacity active:opacity-60"
        style={{ color: t.accent }}
      >
        <ChevronLeft size={22} strokeWidth={2.5} />
        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500, color: t.accent }}>
          Back
        </span>
      </button>
      <h1
        className="flex-1 text-center truncate pr-8"
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 18,
          fontWeight: 700,
          color: t.fg,
          letterSpacing: "-0.3px",
        }}
      >
        {title}
      </h1>
    </div>
  );

  const SongTile = ({ track, onPlay, onOptions, t, currentTrack }: { track: Track; onPlay: () => void; onOptions: () => void; t: any; currentTrack: any }) => {
    const isCurrent = currentTrack.id === track.id;
    return (
      <div
        className="flex items-center justify-between px-5 py-3 transition-colors duration-100 border-b cursor-pointer active:bg-opacity-5 active:bg-white select-none"
        style={{
          borderBottomColor: t.divider,
          backgroundColor: isCurrent ? `${t.highlight}15` : "transparent"
        }}
        onClick={onPlay}
      >
        <div className="flex items-center flex-1 min-w-0 mr-3">
          <div
            className="w-12 h-12 rounded-md overflow-hidden flex-shrink-0 mr-3 shadow-sm relative"
            style={{ backgroundColor: t.secondary }}
          >
            {track.art === "local_music_placeholder" ? (
              <Artwork track={track} className="w-full h-full object-cover" />
            ) : (
              <img src={track.art} alt={track.album} className="w-full h-full object-cover" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p
              className="font-bold truncate"
              style={{
                fontFamily: FONT_DISPLAY,
                fontSize: 16,
                color: isCurrent ? t.accent : t.fg
              }}
            >
              {track.title}
            </p>
            <p
              className="text-xs truncate mt-0.5"
              style={{
                fontFamily: "Inter, sans-serif",
                color: t.muted
              }}
            >
              {track.artist} {track.album ? `— ${track.album}` : ""}
            </p>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOptions();
          }}
          className="p-2 -mr-2 rounded-full transition-colors active:bg-white active:bg-opacity-10"
          style={{ color: t.muted }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="1"></circle>
            <circle cx="12" cy="5" r="1"></circle>
            <circle cx="12" cy="19" r="1"></circle>
          </svg>
        </button>
      </div>
    );
  };

const AllsongsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title="All Songs" t={t} onBack={goBack} />
            <div className="px-4 py-2 flex-shrink-0 select-none">
              <input
                type="text"
                placeholder="Search library..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="w-full px-4 py-2 rounded-lg text-sm border focus:outline-none transition-all duration-200"
                style={{
                  backgroundColor: t.tertiary,
                  color: t.fg,
                  borderColor: t.border,
                }}
              />
            </div>
            {filteredTracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-center px-6 select-none">
                <p style={{ color: t.muted, fontSize: 15, fontFamily: FONT_BODY }}>No music found</p>
              </div>
            ) : (
              <VirtualizedTrackList
                tracks={filteredTracks}
                renderItem={(track) => (
                  <SongTile t={t} currentTrack={currentTrack}
                    track={track}
                    onPlay={() => {
                      setCurrentTrack(track);
                      setIsPlaying(true);
                      setProgress(0);
                      navigate("nowplaying");
                    }}
                    onOptions={() => {
                      setSelectedOptionTrack(track);
                      setIsOptionsModalOpen(true);
                    }}
                  />
                )}
              />
            )}
          </div>
        );
}

const ArtistsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const artistsList = Array.from(new Set(tracks.map((t) => t.artist || "Unknown Artist"))).sort();
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title="Artists" t={t} onBack={goBack} />
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
              {artistsList.map((artist) => {
                const count = tracks.filter((t) => (t.artist || "Unknown Artist") === artist).length;
                return (
                  <button
                    key={artist}
                    onClick={() => {
                      setSelectedArtist(artist);
                      navigate("artistSongs");
                    }}
                    className="w-full flex items-center justify-between px-5 py-4 border-b text-left transition-colors active:bg-white active:bg-opacity-5"
                    style={{ borderBottomColor: t.divider, backgroundColor: "transparent" }}
                  >
                    <div className="min-w-0 flex-1 mr-2">
                      <span className="font-semibold block truncate" style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: t.fg }}>
                        {artist}
                      </span>
                      <span className="text-xs mt-0.5 block" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                        {count} {count === 1 ? "song" : "songs"}
                      </span>
                    </div>
                    <ChevronRight size={16} color={t.muted} strokeWidth={2} />
                  </button>
                );
              })}
            </div>
          </div>
        );
}

const ArtistSongsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const artistTracks = tracks.filter((t) => (t.artist || "Unknown Artist") === selectedArtist);
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title={selectedArtist} t={t} onBack={goBack} />
            <VirtualizedTrackList
              tracks={artistTracks}
              renderItem={(track) => (
                <SongTile t={t} currentTrack={currentTrack}
                  track={track}
                  onPlay={() => {
                    setCurrentTrack(track);
                    setIsPlaying(true);
                    setProgress(0);
                    navigate("nowplaying");
                  }}
                  onOptions={() => {
                    setSelectedOptionTrack(track);
                    setIsOptionsModalOpen(true);
                  }}
                />
              )}
            />
          </div>
        );
}

const AlbumsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const albumsList = Array.from(new Set(tracks.map((t) => t.album || "Unknown Album"))).sort();
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title="Albums" t={t} onBack={goBack} />
            <div className="flex-1 overflow-y-auto px-4 py-4" style={{ scrollbarWidth: "none" }}>
              <div className="grid grid-cols-2 gap-4">
                {albumsList.map((album) => {
                  const albumTracks = tracks.filter((t) => (t.album || "Unknown Album") === album);
                  const count = albumTracks.length;
                  const firstTrack = albumTracks[0];

                  return (
                    <button
                      key={album}
                      onClick={() => {
                        setSelectedAlbum(album);
                        navigate("albumSongs");
                      }}
                      className="flex flex-col text-left transition-transform active:scale-95"
                    >
                      <div
                        className="w-full aspect-square rounded-xl overflow-hidden mb-2 shadow-md relative"
                        style={{ backgroundColor: t.secondary }}
                      >
                        {firstTrack.art === "local_music_placeholder" ? (
                          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900">
                            <span className="text-white opacity-50 font-bold text-3xl">♪</span>
                          </div>
                        ) : (
                          <img src={firstTrack.art} alt={album} className="w-full h-full object-cover" />
                        )}
                      </div>
                      <span className="font-semibold block truncate w-full" style={{ fontFamily: FONT_DISPLAY, fontSize: 14, color: t.fg }}>
                        {album}
                      </span>
                      <span className="text-xs mt-0.5 block truncate w-full" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                        {count} {count === 1 ? "song" : "songs"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
}

const AlbumSongsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const albumTracks = tracks.filter((t) => (t.album || "Unknown Album") === selectedAlbum);
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title={selectedAlbum} t={t} onBack={goBack} />
            <VirtualizedTrackList
              tracks={albumTracks}
              renderItem={(track) => (
                <SongTile t={t} currentTrack={currentTrack}
                  track={track}
                  onPlay={() => {
                    setCurrentTrack(track);
                    setIsPlaying(true);
                    setProgress(0);
                    navigate("nowplaying");
                  }}
                  onOptions={() => {
                    setSelectedOptionTrack(track);
                    setIsOptionsModalOpen(true);
                  }}
                />
              )}
            />
          </div>
        );
}

const GenresScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const genresList = Array.from(new Set(tracks.map((t) => getTrackGenre(t)))).sort();
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title="Genres" t={t} onBack={goBack} />
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
              {genresList.map((genre) => {
                const count = tracks.filter((t) => getTrackGenre(t) === genre).length;
                return (
                  <button
                    key={genre}
                    onClick={() => {
                      setSelectedGenre(genre);
                      navigate("genreSongs");
                    }}
                    className="w-full flex items-center justify-between px-5 py-4 border-b text-left transition-colors active:bg-white active:bg-opacity-5"
                    style={{ borderBottomColor: t.divider, backgroundColor: "transparent" }}
                  >
                    <div className="min-w-0 flex-1 mr-2">
                      <span className="font-semibold block truncate" style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: t.fg }}>
                        {genre}
                      </span>
                      <span className="text-xs mt-0.5 block" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                        {count} {count === 1 ? "song" : "songs"}
                      </span>
                    </div>
                    <ChevronRight size={16} color={t.muted} strokeWidth={2} />
                  </button>
                );
              })}
            </div>
          </div>
        );
}

const GenreSongsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const genreTracks = tracks.filter((t) => getTrackGenre(t) === selectedGenre);
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title={selectedGenre} t={t} onBack={goBack} />
            <VirtualizedTrackList
              tracks={genreTracks}
              renderItem={(track) => (
                <SongTile t={t} currentTrack={currentTrack}
                  track={track}
                  onPlay={() => {
                    setCurrentTrack(track);
                    setIsPlaying(true);
                    setProgress(0);
                    navigate("nowplaying");
                  }}
                  onOptions={() => {
                    setSelectedOptionTrack(track);
                    setIsOptionsModalOpen(true);
                  }}
                />
              )}
            />
          </div>
        );
}

const PlaylistsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const playlistNames = Object.keys(playlists);
        const handleCreatePlaylist = () => {
          const name = newPlaylistName.trim();
          if (!name) return;
          if (playlists[name]) {
            alert("Playlist already exists!");
            return;
          }
          setPlaylists(prev => ({
            ...prev,
            [name]: []
          }));
          setNewPlaylistName("");
        };
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title="Playlists" t={t} onBack={goBack} />
            <form 
              onSubmit={(e) => {
                e.preventDefault();
                handleCreatePlaylist();
              }}
              className="px-5 py-2.5 flex-shrink-0 flex gap-2 border-b" 
              style={{ borderBottomColor: t.divider }}
            >
              <input
                type="text"
                placeholder="New playlist name..."
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                className="flex-1 px-4 py-2 rounded-lg text-sm border focus:outline-none transition-all duration-200"
                style={{
                  backgroundColor: t.tertiary,
                  color: t.fg,
                  borderColor: t.border,
                }}
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-lg text-sm font-bold active:scale-95 transition-all select-none"
                style={{ backgroundColor: t.accent, color: t.highlightText }}
              >
                +
              </button>
            </form>
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
              {playlistNames.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center px-6 select-none">
                  <p style={{ color: t.muted, fontSize: 14, fontFamily: "Inter, sans-serif" }}>No custom playlists. Create one above!</p>
                </div>
              ) : (
                playlistNames.map((name) => {
                  const songCount = playlists[name]?.length || 0;
                  return (
                    <div
                      key={name}
                      className="w-full flex items-center justify-between px-5 py-4 border-b"
                      style={{ borderBottomColor: t.divider }}
                    >
                      <button
                        onClick={() => {
                          setSelectedPlaylistName(name);
                          navigate("playlistSongs");
                        }}
                        className="flex-1 text-left min-w-0"
                        style={{ backgroundColor: "transparent" }}
                      >
                        <span className="font-semibold block truncate" style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: t.fg }}>
                          {name}
                        </span>
                        <span className="text-xs mt-0.5 block" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                          {songCount} {songCount === 1 ? "song" : "songs"}
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Are you sure you want to delete playlist "${name}"?`)) {
                            setPlaylists(prev => {
                              const copy = { ...prev };
                              delete copy[name];
                              return copy;
                            });
                          }
                        }}
                        className="p-2 text-red-500 rounded-full transition-colors active:bg-white active:bg-opacity-10 select-none"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
}

const PlaylistSongsScreen = (props: any) => {
  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  } = props;
        const songIds = playlists[selectedPlaylistName] || [];
        const playlistTracks = tracks.filter((t) => songIds.includes(t.id));
        return (
          <div className="flex flex-col flex-1 overflow-hidden" style={{ backgroundColor: t.bg }}>
            <ScreenHeader title={selectedPlaylistName} t={t} onBack={goBack} />
            
            <div className="px-5 py-3 border-b flex-shrink-0" style={{ borderBottomColor: t.divider }}>
              <button
                onClick={() => setIsAddSongsToPlaylistOpen(true)}
                className="w-full py-2.5 rounded-lg font-bold transition-all active:scale-95"
                style={{ backgroundColor: t.accent, color: t.highlightText, fontSize: 15 }}
              >
                + Add Songs
              </button>
            </div>

            {playlistTracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-center px-6 select-none">
                <p style={{ color: t.muted, fontSize: 14, fontFamily: "Inter, sans-serif" }}>Playlist is empty.</p>
              </div>
            ) : (
              <VirtualizedTrackList
                tracks={playlistTracks}
                renderItem={(track) => (
                  <SongTile t={t} currentTrack={currentTrack}
                    track={track}
                    onPlay={() => {
                      setCurrentTrack(track);
                      setIsPlaying(true);
                      setProgress(0);
                      navigate("nowplaying");
                    }}
                    onOptions={() => {
                      setSelectedOptionTrack(track);
                      setIsOptionsModalOpen(true);
                    }}
                  />
                )}
              />
            )}
          </div>
        );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>("black");
  const [screen, setScreen] = useState<Screen>("home");
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);
  const screenHistoryRef = useRef<Screen[]>([]);

  useEffect(() => {
    screenHistoryRef.current = screenHistory;
  }, [screenHistory]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(1);
  const isSeeking = useRef(false);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track>(EMPTY_TRACK);
  const [isScanning, setIsScanning] = useState(false);

  const [shuffle, setShuffle] = useState(false);
  const shuffleOrder = useRef<number[]>([]);
  const shufflePointer = useRef(0);
  const [repeat, setRepeat] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [cflowIndex, setCflowIndex] = useState(0);
  const [time, setTime] = useState(new Date());

  // Additional music management states
  const [playlists, setPlaylists] = useState<Record<string, number[]>>({});
  const [selectedPlaylistName, setSelectedPlaylistName] = useState<string>("");
  const [selectedArtist, setSelectedArtist] = useState<string>("");
  const [selectedAlbum, setSelectedAlbum] = useState<string>("");
  const [selectedGenre, setSelectedGenre] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedOptionTrack, setSelectedOptionTrack] = useState<Track | null>(null);
  const [isOptionsModalOpen, setIsOptionsModalOpen] = useState(false);
  const [isPlaylistSelectOpen, setIsPlaylistSelectOpen] = useState(false);
  const [isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [isCreatingModalPlaylist, setIsCreatingModalPlaylist] = useState(false);
  const [modalPlaylistName, setModalPlaylistName] = useState("");

  const volDragRef = useRef<{ startY: number, startVol: number } | null>(null);
  const [volumeOverlay, setVolumeOverlay] = useState<number | null>(null);

  const [isLandscape, setIsLandscape] = useState(window.innerWidth > window.innerHeight);

  useEffect(() => {
    const onResize = () => setIsLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const [crossfadeDuration, setCrossfadeDuration] = useState(2500);

  const audioRefA = useRef<HTMLAudioElement | null>(null);
  const audioRefB = useRef<HTMLAudioElement | null>(null);
  const activeAudioRef = useRef<'A' | 'B'>('A');

  const audioRef = useMemo(() => {
    return {
      get current() {
        return activeAudioRef.current === 'A' ? audioRefA.current : audioRefB.current;
      }
    };
  }, []);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainARef = useRef<GainNode | null>(null);
  const gainBRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const prevShuffleRef = useRef(false);
  const prevTrackCountRef = useRef(0);
  const currentTrackIdRef = useRef(currentTrack.id);
  currentTrackIdRef.current = currentTrack.id;

  const isPlaylistsLoaded = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPlayedUrl = useRef<string | null>(null);
  const t = THEMES[theme];

  // Load cached songs and playlists on mount
  useEffect(() => {
    const loadCachedData = async () => {
      try {
        let tracksVal = null;
        try {
          const res = await Filesystem.readFile({
            path: 'local_tracks.json',
            directory: Directory.Data,
            encoding: Encoding.UTF8
          });
          tracksVal = res.data;
        } catch (e) {
          // File might not exist yet
          try {
            // Fallback for legacy users
            const prefRes = await Preferences.get({ key: "local_tracks" });
            tracksVal = prefRes.value;
          } catch (ignored) {}
        }

        if (tracksVal && typeof tracksVal === 'string') {
          const cached: Track[] = JSON.parse(tracksVal);
          if (cached && cached.length > 0) {
            // Re-apply Capacitor.convertFileSrc for scanned tracks (the capacitor:// URL
            // can change between app restarts; localPath is the stable file:// URI).
            // Also filter out blob: URLs from file-picker imports — they expire after restart.
            const rehydrated = cached
              .filter((tr) => {
                // Drop expired blob: URLs (file-picker imports don't survive restarts)
                if (tr.url && tr.url.startsWith("blob:")) return false;
                return true;
              })
              .map((tr) => {
                // Re-derive the playable URL from the stable localPath
                const updated = { ...tr };
                if (Capacitor.isNativePlatform()) {
                  if (tr.localPath) {
                    updated.url = Capacitor.convertFileSrc(tr.localPath);
                  }
                  // Re-derive cover art URL from saved art file path
                  if (tr.artLocalPath) {
                    updated.art = Capacitor.convertFileSrc(tr.artLocalPath);
                  }
                }
                return updated;
              });

            if (rehydrated.length > 0) {
              setTracks(rehydrated);
              setCurrentTrack(rehydrated[0]);
            }
          }
        }

        const { value: playlistsVal } = await Preferences.get({ key: "local_playlists" });
        if (playlistsVal) {
          setPlaylists(JSON.parse(playlistsVal));
        }

        // Auto-sync on every launch: silently scan in the background to pick up new songs.
        // On first launch (no cache) we do a full scan; on subsequent launches we do an
        // incremental sync that only adds files not already in the library.
        if (Capacitor.isNativePlatform()) {
          setTimeout(() => { scanStorage(/* silent incremental */ true); }, 1000);
        }
      } catch (err) {
        console.error("Failed to load cached data", err);
      } finally {
        isPlaylistsLoaded.current = true;
      }
    };
    loadCachedData();
  }, []);

  // Save playlists whenever it changes
  useEffect(() => {
    if (!isPlaylistsLoaded.current) return;
    const savePlaylists = async () => {
      try {
        await Preferences.set({
          key: "local_playlists",
          value: JSON.stringify(playlists)
        });
      } catch (err) {
        console.error("Failed to save playlists", err);
      }
    };
    savePlaylists();
  }, [playlists]);

  // Debounce search input for large libraries
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 150);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return tracks;
    const q = searchQuery.toLowerCase();
    return tracks.filter(
      (tr) =>
        tr.title.toLowerCase().includes(q) ||
        tr.artist.toLowerCase().includes(q)
    );
  }, [tracks, searchQuery]);

  // Background artwork extraction for tracks that missed it
  useEffect(() => {
    if (tracks.length === 0) return;
    
    let isCancelled = false;
    
    const extractMissingArtwork = async () => {
      let updatedTracks = [...tracks];
      let needsSave = false;
      let extractCount = 0;
      
      for (let i = 0; i < updatedTracks.length; i++) {
        if (isCancelled) return;
        
        // Extract art if it hasn't been extracted yet and it's a local file
        if (!updatedTracks[i].hasExtractedArt && updatedTracks[i].art === "local_music_placeholder" && updatedTracks[i].url && !updatedTracks[i].url.startsWith("blob:")) {
          try {
            const meta = await extractId3Metadata(updatedTracks[i].url!);
            if (meta.genre) {
              updatedTracks[i].genre = meta.genre;
            }
            if (meta.artBase64) {
              const artFileName = `cover_${updatedTracks[i].id}.jpg`;
              await Filesystem.writeFile({
                path: artFileName,
                data: meta.artBase64,
                directory: Directory.Data,
                recursive: true
              });
              const artUri = await Filesystem.getUri({ path: artFileName, directory: Directory.Data });
              updatedTracks[i].artLocalPath = artUri.uri;
              updatedTracks[i].art = Capacitor.convertFileSrc(artUri.uri);
            }
            // Mark as attempted so we don't try again
            updatedTracks[i].hasExtractedArt = true;
            needsSave = true;
            extractCount++;
            
            // Save state every 5 successful extractions to avoid react re-render spam
            if (needsSave && extractCount % 5 === 0) {
               setTracks([...updatedTracks]);
            }
          } catch (err) {
             console.warn("Background extraction failed for", updatedTracks[i].title, err);
             updatedTracks[i].hasExtractedArt = true; // don't get stuck in a loop
             needsSave = true;
          }
        }
      }
      
      if (needsSave && !isCancelled) {
        setTracks(updatedTracks);
        saveTracks(updatedTracks);
      }
    };
    
    // Slight delay to not freeze UI on initial load
    setTimeout(extractMissingArtwork, 3000);
    
    return () => { isCancelled = true; };
  }, [tracks.length]);

  const saveTracks = async (updatedTracks: Track[]) => {
    try {
      await Filesystem.writeFile({
        path: 'local_tracks.json',
        data: JSON.stringify(updatedTracks),
        directory: Directory.Data,
        encoding: Encoding.UTF8
      });
    } catch (err) {
      console.error("Failed to save tracks", err);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (tracks.length > 0) {
        setSlideIndex((i) => (i + 1) % tracks.length);
      }
    }, 3800);
    return () => clearInterval(timer);
  }, [tracks]);

  const navigate = useCallback(
    (to: Screen) => {
      setScreenHistory((h) => [...h, screen]);
      setScreen(to);
      setActiveIndex(0);
      setSearchInput("");
      setSearchQuery("");
    },
    [screen]
  );

  const goBack = useCallback(() => {
    setScreenHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setScreen(prev);
      setActiveIndex(0);
      return h.slice(0, -1);
    });
  }, []);

  // Generate a true Fisher-Yates shuffle order
  const generateShuffleOrder = useCallback((excludeCurrentIdx: number = -1) => {
    if (tracks.length === 0) {
      shuffleOrder.current = [];
      shufflePointer.current = 0;
      return;
    }
    const order = Array.from({ length: tracks.length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    
    // If we're currently playing a song, ensure it's not the new first song (unless it's the only one)
    if (excludeCurrentIdx >= 0 && tracks.length > 1 && order[0] === excludeCurrentIdx) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    
    shuffleOrder.current = order;
    shufflePointer.current = 0;
  }, [tracks.length]);

  // When shuffle is turned ON or track list changes, generate a new order
  useEffect(() => {
    const trackCountChanged = tracks.length !== prevTrackCountRef.current;
    const shuffleJustEnabled = shuffle && !prevShuffleRef.current;

    if (shuffle && (shuffleJustEnabled || trackCountChanged)) {
      const currentIdx = tracks.findIndex((tr) => tr.id === currentTrackIdRef.current);
      generateShuffleOrder(currentIdx >= 0 ? currentIdx : -1);
    }
    if (!shuffle) {
      shuffleOrder.current = [];
      shufflePointer.current = 0;
    }

    prevShuffleRef.current = shuffle;
    prevTrackCountRef.current = tracks.length;
  }, [shuffle, tracks.length, generateShuffleOrder]);

  const skipNext = useCallback(() => {
    if (tracks.length === 0) return;
    
    let nextIdx = 0;
    if (shuffle) {
      shufflePointer.current += 1;
      if (shufflePointer.current >= shuffleOrder.current.length) {
        // Reshuffle and start over, ensuring we don't immediately repeat the last played track
        const lastPlayedIdx = shuffleOrder.current[shuffleOrder.current.length - 1];
        generateShuffleOrder(lastPlayedIdx);
      }
      nextIdx = shuffleOrder.current[shufflePointer.current] || 0;
    } else {
      const idx = tracks.findIndex((tr) => tr.id === currentTrack.id);
      nextIdx = (idx + 1) % tracks.length;
    }
    
    if (tracks[nextIdx]) {
      setCurrentTrack(tracks[nextIdx]);
      setProgress(0);
    }
  }, [currentTrack, tracks, shuffle, generateShuffleOrder]);

  const skipPrev = useCallback(() => {
    if (tracks.length === 0) return;
    
    let prevIdx = 0;
    if (shuffle) {
      shufflePointer.current -= 1;
      if (shufflePointer.current < 0) {
        shufflePointer.current = Math.max(0, shuffleOrder.current.length - 1);
      }
      prevIdx = shuffleOrder.current[shufflePointer.current] || 0;
    } else {
      const idx = tracks.findIndex((tr) => tr.id === currentTrack.id);
      prevIdx = (idx - 1 + tracks.length) % tracks.length;
    }
    
    if (tracks[prevIdx]) {
      setCurrentTrack(tracks[prevIdx]);
      setProgress(0);
    }
  }, [currentTrack, tracks, shuffle]);

  // Hardware Back Button
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listener = CapacitorApp.addListener('backButton', () => {
      if (screenHistoryRef.current.length > 0) {
        goBack();
      } else {
        CapacitorApp.exitApp();
      }
    });
    return () => {
      listener.then(l => l.remove()).catch(console.error);
    };
  }, [goBack]);

  // Media Session Integration
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (currentTrack.title) {
      MediaSession.setMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist || 'Unknown Artist',
        album: currentTrack.album || 'Unknown Album',
        // Media session requires standard URLs for artwork, local file URIs might not render correctly,
        // but we pass it just in case Android handles it.
        artwork: currentTrack.art && currentTrack.art !== "local_music_placeholder"
          ? [{ src: currentTrack.art, sizes: '512x512', type: 'image/jpeg' }]
          : undefined
      }).catch(console.error);
    }
  }, [currentTrack]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    MediaSession.setPlaybackState({ playbackState: isPlaying ? 'playing' : 'paused' }).catch(console.error);
  }, [isPlaying]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    MediaSession.setActionHandler({ action: 'play' }, () => {
      setIsPlaying(true);
      if (audioRef.current) audioRef.current.play().catch(console.error);
    }).catch(console.error);
    MediaSession.setActionHandler({ action: 'pause' }, () => {
      setIsPlaying(false);
      if (audioRef.current) audioRef.current.pause();
    }).catch(console.error);
    MediaSession.setActionHandler({ action: 'nexttrack' }, () => skipNext()).catch(console.error);
    MediaSession.setActionHandler({ action: 'previoustrack' }, () => skipPrev()).catch(console.error);
    MediaSession.setActionHandler({ action: 'seekforward' }, () => skipNext()).catch(console.error);
    MediaSession.setActionHandler({ action: 'seekbackward' }, () => skipPrev()).catch(console.error);
  }, [skipNext, skipPrev]);

  // Web Audio Context initialization (crossfade + visualizer)
  const initWebAudio = useCallback(() => {
    if (audioCtxRef.current) return;
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;

    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      const gainA = ctx.createGain();
      const gainB = ctx.createGain();
      const analyser = ctx.createAnalyser();
      const masterGain = ctx.createGain();
      analyser.fftSize = 128;

      if (audioRefA.current && audioRefB.current) {
        const sourceA = ctx.createMediaElementSource(audioRefA.current);
        const sourceB = ctx.createMediaElementSource(audioRefB.current);
        sourceA.connect(gainA);
        sourceB.connect(gainB);
        audioRefA.current.volume = 1;
        audioRefB.current.volume = 1;
      }

      gainA.connect(analyser);
      gainB.connect(analyser);
      analyser.connect(masterGain);
      masterGain.connect(ctx.destination);

      gainARef.current = gainA;
      gainBRef.current = gainB;
      masterGainRef.current = masterGain;
      analyserRef.current = analyser;
    } catch (e) {
      console.error("Web Audio API failed to initialize", e);
    }
  }, []);

  // Initial load logic
  useEffect(() => {
    const audioA = new Audio();
    audioA.crossOrigin = "anonymous";
    const audioB = new Audio();
    audioB.crossOrigin = "anonymous";
    
    audioRefA.current = audioA;
    audioRefB.current = audioB;

    return () => {
      audioA.pause();
      audioA.src = "";
      audioB.pause();
      audioB.src = "";
    };
  }, []);

  const handleTimeUpdate = useCallback((e: Event) => {
    const target = e.target as HTMLAudioElement;
    if (target !== audioRef.current) return;
    if (target.duration) {
      setProgress(target.currentTime / target.duration);
    }
  }, [audioRef]);

  const handleDurationChange = useCallback((e: Event) => {
    const target = e.target as HTMLAudioElement;
    if (target !== audioRef.current) return;
    if (target.duration) {
      const dynamicDuration = Math.round(target.duration);
      // Update the current track duration dynamically in our state
      setCurrentTrack(prev => ({
        ...prev,
        duration: dynamicDuration
      }));
      setTracks(prevTracks => prevTracks.map(t => t.id === currentTrack.id ? { ...t, duration: dynamicDuration } : t));
    }
  }, [audioRef, currentTrack.id]);

  const handleEnded = useCallback((e: Event) => {
    const target = e.target as HTMLAudioElement;
    if (target !== audioRef.current) return;
    if (repeat) {
      target.currentTime = 0;
      target.play().catch(console.error);
    } else {
      skipNext();
    }
  }, [audioRef, repeat, skipNext]);

  const handleError = useCallback((e: Event) => {
    const target = e.target as HTMLAudioElement;
    if (target !== audioRef.current) return;
    console.warn("Audio playback error encountered. Auto-skipping...", e);
    setTimeout(() => {
      skipNext();
    }, 1200);
  }, [audioRef, skipNext]);

  // Audio elements event binding
  useEffect(() => {
    const audioA = audioRefA.current;
    const audioB = audioRefB.current;
    if (!audioA || !audioB) return;

    [audioA, audioB].forEach(audio => {
      audio.addEventListener("timeupdate", handleTimeUpdate);
      audio.addEventListener("durationchange", handleDurationChange);
      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("error", handleError as any);
    });

    return () => {
      [audioA, audioB].forEach(audio => {
        audio.removeEventListener("timeupdate", handleTimeUpdate);
        audio.removeEventListener("durationchange", handleDurationChange);
        audio.removeEventListener("ended", handleEnded);
        audio.removeEventListener("error", handleError as any);
      });
    };
  }, [audioRefA, audioRefB, handleTimeUpdate, handleDurationChange, handleEnded, handleError]);

  // Sync volume to audio elements (or master gain when Web Audio is active)
  useEffect(() => {
    if (masterGainRef.current && audioCtxRef.current) {
      masterGainRef.current.gain.value = volume;
      return;
    }
    if (audioRefA.current) audioRefA.current.volume = volume;
    if (audioRefB.current) audioRefB.current.volume = volume;
  }, [volume]);

  // Playback control when currentTrack or isPlaying changes
  useEffect(() => {
    const active = audioRef.current;
    if (!active) return;

    if (currentTrack.url) {
      if (lastPlayedUrl.current !== currentTrack.url) {
        initWebAudio();

        const inactiveAudio = activeAudioRef.current === 'A' ? audioRefB.current : audioRefA.current;
        const activeGain = activeAudioRef.current === 'A' ? gainARef.current : gainBRef.current;
        const inactiveGain = activeAudioRef.current === 'A' ? gainBRef.current : gainARef.current;
        const useCrossfade = crossfadeDuration > 0 && isPlaying && lastPlayedUrl.current;

        if (useCrossfade && inactiveAudio && audioCtxRef.current && activeGain && inactiveGain) {
          const ctx = audioCtxRef.current;
          if (ctx.state === 'suspended') ctx.resume();

          // Swap active reference immediately
          activeAudioRef.current = activeAudioRef.current === 'A' ? 'B' : 'A';
          const newActive = inactiveAudio;
          
          newActive.src = currentTrack.url;
          newActive.load();
          lastPlayedUrl.current = currentTrack.url;

          const now = ctx.currentTime;
          
          // Ensure clean values
          inactiveGain.gain.cancelScheduledValues(now);
          inactiveGain.gain.setValueAtTime(0, now);
          inactiveGain.gain.linearRampToValueAtTime(1, now + crossfadeDuration / 1000);

          activeGain.gain.cancelScheduledValues(now);
          activeGain.gain.setValueAtTime(activeGain.gain.value, now);
          activeGain.gain.linearRampToValueAtTime(0, now + crossfadeDuration / 1000);

          newActive.play().catch(err => {
            console.warn("Audio playback failed:", err);
            setIsPlaying(false);
          });

          setTimeout(() => {
            active.pause();
          }, crossfadeDuration);
          
        } else {
          // Hard cut (crossfade off or first track)
          if (inactiveAudio) inactiveAudio.pause();
          if (audioCtxRef.current && activeGain && inactiveGain) {
            const now = audioCtxRef.current.currentTime;
            activeGain.gain.cancelScheduledValues(now);
            inactiveGain.gain.cancelScheduledValues(now);
            activeGain.gain.setValueAtTime(1, now);
            inactiveGain.gain.setValueAtTime(0, now);
          }
          active.src = currentTrack.url;
          active.load();
          lastPlayedUrl.current = currentTrack.url;

          if (isPlaying) {
            active.play().catch(err => {
              console.warn("Audio playback failed:", err);
              setIsPlaying(false);
            });
          }
        }
      } else {
        if (isPlaying) {
          active.play().catch(err => {
            console.warn("Audio playback failed:", err);
            setIsPlaying(false);
          });
        } else {
          active.pause();
        }
      }
    }
  }, [currentTrack.url, isPlaying, crossfadeDuration, initWebAudio, volume, audioRef]);

  // Helper: seek the audio element to a ratio (0-1) and update progress state
  const seekTo = useCallback((ratio: number) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    setProgress(clamped);
    if (audioRef.current && audioRef.current.duration && !isNaN(audioRef.current.duration)) {
      audioRef.current.currentTime = clamped * audioRef.current.duration;
    }
  }, []);

  const scanStorage = async (silent = false) => {
    setIsScanning(true);
    try {
      let permissionGranted = false;
      try {
        const permission = await Filesystem.requestPermissions();
        if (permission.publicStorage === "granted") {
          permissionGranted = true;
        }
      } catch (err) {
        console.warn("Permission API failed. Probably in browser.", err);
      }

      if (!permissionGranted && Capacitor.isNativePlatform()) {
        alert("Storage permission is required to scan device files.");
        setIsScanning(false);
        return;
      }

      // Load existing cached tracks so we can do incremental sync
      let existingTracks: Track[] = [];
      try {
        const res = await Filesystem.readFile({
          path: 'local_tracks.json',
          directory: Directory.Data,
          encoding: Encoding.UTF8
        });
        if (typeof res.data === 'string') {
          existingTracks = JSON.parse(res.data);
        }
      } catch (e) {
        // Fallback for legacy users
        const prefRes = await Preferences.get({ key: "local_tracks" }).catch(() => ({ value: null }));
        existingTracks = prefRes.value ? JSON.parse(prefRes.value) : [];
      }
      const existingPaths = new Set(existingTracks.map(t => t.localPath).filter(Boolean));

      const newTracks: Track[] = [];
      let idCounter = Date.now(); // unique IDs based on timestamp to avoid collisions
      
      let tracksToScan: { url: string; title?: string; artist?: string; album?: string; duration?: number }[] = [];

      if (Capacitor.isNativePlatform()) {
        try {
          const result = await MediaStore.getAudioFiles();
          tracksToScan = result.tracks || [];
        } catch (e) {
          console.error("Failed to fetch audio from MediaStore", e);
          if (!silent) alert("Failed to fetch audio from device.");
          setIsScanning(false);
          return;
        }
      } else {
        // Fallback for web
        if (!silent) alert("Media scanning is only supported natively on iOS and Android.");
        setIsScanning(false);
        return;
      }

      for (const nativeTrack of tracksToScan) {
        const filePath = nativeTrack.url;
        if (existingPaths.has(filePath)) continue; // skip already scanned files

        try {
          const fileUrl = Capacitor.convertFileSrc(filePath);
          let baseName = filePath.substring(filePath.lastIndexOf("/") + 1);
          if (baseName.lastIndexOf(".") > 0) {
            baseName = baseName.substring(0, baseName.lastIndexOf("."));
          }

          let artist = nativeTrack.artist && nativeTrack.artist !== "<unknown>" ? nativeTrack.artist : "Unknown Artist";
          let title = nativeTrack.title || baseName;
          
          if (title === baseName && baseName.includes("-")) {
            const parts = baseName.split("-");
            artist = parts[0].trim();
            title = parts.slice(1).join("-").trim();
          }

          newTracks.push({
            id: idCounter++,
            title,
            artist,
            album: nativeTrack.album && nativeTrack.album !== "<unknown>" ? nativeTrack.album : "Unknown Album",
            duration: nativeTrack.duration || 180,
            art: "local_music_placeholder",
            url: fileUrl,
            localPath: filePath,
            hasExtractedArt: false
          });
        } catch (e) {
          console.error("Failed to parse file", filePath, e);
        }
      }

      if (newTracks.length > 0) {
        const merged = [...existingTracks, ...newTracks];
        setTracks(merged);
        if (existingTracks.length === 0 && newTracks.length > 0) {
          setCurrentTrack(newTracks[0]);
        }
        await saveTracks(merged);

        const msg = existingTracks.length === 0
          ? `Found ${newTracks.length} songs and synced instantly!`
          : `Added ${newTracks.length} new song${newTracks.length > 1 ? 's' : ''} to your library.`;
        if (!silent || existingTracks.length === 0) alert(msg);
      } else if (!silent) {
        alert("No new audio files found in Music or Download folders.");
      }
    } catch (err) {
      console.error("Scan error:", err);
      alert("Error scanning local storage.");
    } finally {
      setIsScanning(false);
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const importedTracks: Track[] = [];
    let idCounter = 2000;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const objectUrl = URL.createObjectURL(file);
      const baseName = file.name.substring(0, file.name.lastIndexOf("."));

      let artist = "Unknown Artist";
      let title = baseName;
      if (baseName.includes("-")) {
        const parts = baseName.split("-");
        artist = parts[0].trim();
        title = parts.slice(1).join("-").trim();
      }

      importedTracks.push({
        id: idCounter++,
        title,
        artist,
        album: "Local Import",
        duration: 180, // will load dynamic duration
        art: "local_music_placeholder",
        url: objectUrl
      });
    }

    if (importedTracks.length > 0) {
      setTracks(prev => {
        // Find highest existing ID to avoid collisions (if any)
        const highestId = prev.length > 0 ? Math.max(...prev.map(t => t.id)) : 0;
        const newTracksWithValidIds = importedTracks.map((t, idx) => ({ ...t, id: highestId + 1 + idx }));
        
        // We'll update state with these tracks
        setTimeout(async () => {
          // Extract metadata progressively
          for (let idx = 0; idx < newTracksWithValidIds.length; idx++) {
            const track = newTracksWithValidIds[idx];
            if (!track.url) continue;
            try {
              const meta = await extractId3Metadata(track.url);
              
              let updatedArt = track.art;
              if (meta.artBase64 && meta.artMime) {
                updatedArt = `data:${meta.artMime};base64,${meta.artBase64}`;
              }

              setTracks(current => current.map(t => {
                if (t.id === track.id) {
                  return {
                    ...t,
                    title: meta.title || t.title,
                    artist: meta.artist || t.artist,
                    album: meta.album || t.album,
                    genre: meta.genre || t.genre,
                    art: updatedArt
                  };
                }
                return t;
              }));
            } catch (e) {
              console.warn("Failed to extract ID3 for imported file", e);
            }
          }
        }, 100);

        return [...prev, ...newTracksWithValidIds];
      });
      
      setCurrentTrack(importedTracks[0]);
      setProgress(0);
      setIsPlaying(false);
      alert(`Imported ${importedTracks.length} tracks successfully! Extracting metadata...`);
    }
  };



  const clearLibrary = async () => {
    if (!confirm("Clear your music library? All scanned songs and playlists will be removed.")) {
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setTracks([]);
    setCurrentTrack(EMPTY_TRACK);
    setProgress(0);
    setIsPlaying(false);
    setPlaylists({});
    await Preferences.remove({ key: "local_tracks" });
    await Preferences.remove({ key: "local_playlists" });
  };

  const menuRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const homeMenuItems = [
    { label: "Music", action: () => navigate("music") },
    { label: "Settings", action: () => navigate("settings") },
    {
      label: "Shuffle Songs",
      action: () => {
        if (tracks.length > 0) {
          generateShuffleOrder(-1);
          shufflePointer.current = 0;
          setShuffle(true);
          setCurrentTrack(tracks[shuffleOrder.current[0]]);
          setIsPlaying(true);
          setProgress(0);
        } else {
          setShuffle(true);
        }
        navigate("nowplaying");
      }
    },
    { label: "Now Playing", action: () => navigate("nowplaying") },
  ];

  const musicMenuItems = [
    { label: "Cover Flow", action: () => navigate("coverflow") },
    { label: "All Songs", action: () => navigate("allsongs") },
    { label: "Playlists", action: () => navigate("playlists") },
    { label: "Artists", action: () => navigate("artists") },
    { label: "Albums", action: () => navigate("albums") },
    { label: "Genres", action: () => navigate("genres") },
    { label: "Scan Music Library", action: scanStorage },
    { label: "Clear Library", action: clearLibrary },
  ];

  const settingsMenuItems = [
    { label: "Shuffle", type: "toggle" as const, value: shuffle, onToggle: () => setShuffle((s) => !s) },
    { label: "Repeat", type: "toggle" as const, value: repeat, onToggle: () => setRepeat((r) => !r) },
    { label: "Crossfade", type: "crossfade" as const },
    { label: "Theme", type: "theme" as const },
    { label: "Device Color", type: "color" as const },
  ];

  const lastHapticIdx = useRef(-1);

  const updateSelection = (y: number) => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const relY = y - rect.top;
    const itemH = rect.height / homeMenuItems.length;
    const idx = Math.max(0, Math.min(homeMenuItems.length - 1, Math.floor(relY / itemH)));
    setActiveIndex(idx);
    if (lastHapticIdx.current !== idx) {
      lastHapticIdx.current = idx;
      Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
    }
  };

  // ── Cover Flow Physics Engine ──────────────────────────────
  // cfOffsetRef holds the real-time (fractional) index position, e.g. 2.37
  // cflowIndex holds the snapped integer index for track info display
  const cfStartX = useRef(0);
  const cfStartTime = useRef(0);
  const cfVelocity = useRef(0);       // px/ms at release
  const cfOffsetRef = useRef(0);      // continuous floating index (source of truth during drag)
  const cfAnimRef = useRef<number>(0); // rAF handle
  const cfIsDragging = useRef(false);
  const carouselRef = useRef<HTMLDivElement>(null);
  const cfLastX = useRef(0);
  const cfLastTime = useRef(0);

  // Apply transforms to DOM children directly — bypass React render cycle for 60fps
  const applyCarouselTransforms = useCallback((offsetF: number) => {
    if (!carouselRef.current) return;
    const children = carouselRef.current.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLDivElement;
      if (!child) continue;
      const trackIdx = parseInt(child.dataset.index || "0", 10);
      const rel = trackIdx - offsetF;   // float relative position
      const absRel = Math.abs(rel);

      // Only transform visible window
      if (absRel > 5) {
        child.style.opacity = "0";
        child.style.pointerEvents = "none";
        continue;
      }
      child.style.opacity = "1";
      child.style.pointerEvents = "auto";

      const sign = Math.sign(rel);
      
      // 1. Visuals: Center 100% and flat, sides rotated ±60 deg
      const rotateY = -sign * Math.min(60, absRel * 60);

      // 2. Visuals: Side albums overlap tightly
      const overlapSpacing = 40;
      const centerSpacing = 120;
      let translateX = 0;
      if (absRel > 0) {
        translateX = sign * (centerSpacing * Math.min(1, absRel) + Math.max(0, absRel - 1) * overlapSpacing);
      }
      
      // 3. Visuals: Pushed back slightly (translateZ) and scaled down
      const translateZ = -Math.min(150, absRel * 150);
      const scale = Math.max(0.75, 1 - absRel * 0.15);

      const brightness = Math.max(0.2, 1 - absRel * 0.35);
      const zIndex = Math.round(100 - absRel * 10);

      child.style.transform = `translate(-50%, -50%) translateX(${translateX}px) translateZ(${translateZ}px) rotateY(${rotateY}deg) scale(${scale})`;
      child.style.filter = `brightness(${brightness})`;
      child.style.zIndex = String(zIndex);
      child.style.transition = "none"; // We drive everything via rAF
    }
  }, []);

  // Spring snap to nearest integer index after release
  const springToIndex = useCallback((targetIdx: number, initialVelocity: number) => {
    cancelAnimationFrame(cfAnimRef.current);
    const STIFFNESS = 0.06;   // spring stiffness (lower = softer)
    const DAMPING   = 0.95;   // damping ratio (near 1.0 for high friction/gliding stop)
    const VELOCITY_SCALE = 0.005; // convert px/ms velocity into index/frame

    let vel = -initialVelocity * VELOCITY_SCALE; 
    let current = cfOffsetRef.current;
    let lastHapticIdx = Math.round(current);

    const tick = () => {
      const dist = current - targetIdx;
      const spring = -STIFFNESS * dist;
      vel = (vel + spring) * DAMPING;
      current += vel;
      cfOffsetRef.current = current;
      applyCarouselTransforms(current);

      // Haptic tick exactly every time the center index shifts from one album to the next
      const currentHapticIdx = Math.round(current);
      if (currentHapticIdx !== lastHapticIdx) {
        lastHapticIdx = currentHapticIdx;
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      }

      // Settled check
      if (Math.abs(dist) < 0.0008 && Math.abs(vel) < 0.0008) {
        cfOffsetRef.current = targetIdx;
        applyCarouselTransforms(targetIdx);
        return;
      }
      cfAnimRef.current = requestAnimationFrame(tick);
    };
    cfAnimRef.current = requestAnimationFrame(tick);
  }, [applyCarouselTransforms]);

  // Sync transforms whenever cflowIndex or tracks change (initial render)
  useEffect(() => {
    cfOffsetRef.current = cflowIndex;
    applyCarouselTransforms(cflowIndex);
  }, [cflowIndex, tracks, screen, applyCarouselTransforms]);

  const handleCfTouchStart = (e: React.TouchEvent) => {
    cancelAnimationFrame(cfAnimRef.current);
    cfStartX.current = e.touches[0].clientX;
    cfLastX.current = e.touches[0].clientX;
    cfLastTime.current = performance.now();
    cfStartTime.current = performance.now();
    cfVelocity.current = 0;
    cfIsDragging.current = true;
  };
  const handleCfTouchMove = (e: React.TouchEvent) => {
    if (!cfIsDragging.current) return;
    const now = performance.now();
    const dx = e.touches[0].clientX - cfLastX.current;
    const dt = now - cfLastTime.current;
    if (dt > 0) cfVelocity.current = dx / dt; // px/ms
    cfLastX.current = e.touches[0].clientX;
    cfLastTime.current = now;

    const totalDelta = e.touches[0].clientX - cfStartX.current;
    // 130px of drag = 1 album index change
    const newOffset = cflowIndex - totalDelta / 130;
    const clamped = Math.max(0, Math.min(tracks.length - 1, newOffset));
    cfOffsetRef.current = clamped;
    applyCarouselTransforms(clamped);
  };
  const handleCfTouchEnd = () => {
    if (!cfIsDragging.current) return;
    cfIsDragging.current = false;

    // Momentum coasting based on release velocity
    // -cfVelocity because swiping left (negative velocity) increases index
    const coastDist = -cfVelocity.current * 8; 
    let targetIdx = Math.round(cfOffsetRef.current + coastDist);
    targetIdx = Math.max(0, Math.min(tracks.length - 1, targetIdx));
    
    setCflowIndex(targetIdx);
    springToIndex(targetIdx, cfVelocity.current);
  };

  const handleCfMouseDown = (e: React.MouseEvent) => {
    cancelAnimationFrame(cfAnimRef.current);
    cfStartX.current = e.clientX;
    cfLastX.current = e.clientX;
    cfLastTime.current = performance.now();
    cfVelocity.current = 0;
    cfIsDragging.current = true;
  };
  const handleCfMouseMove = (e: React.MouseEvent) => {
    if (!cfIsDragging.current) return;
    const now = performance.now();
    const dx = e.clientX - cfLastX.current;
    const dt = now - cfLastTime.current;
    if (dt > 0) cfVelocity.current = dx / dt;
    cfLastX.current = e.clientX;
    cfLastTime.current = now;

    const totalDelta = e.clientX - cfStartX.current;
    const newOffset = cflowIndex - totalDelta / 130;
    const clamped = Math.max(0, Math.min(tracks.length - 1, newOffset));
    cfOffsetRef.current = clamped;
    applyCarouselTransforms(clamped);
  };
  const handleCfMouseUp = () => {
    if (!cfIsDragging.current) return;
    cfIsDragging.current = false;
    
    const coastDist = -cfVelocity.current * 8; 
    let targetIdx = Math.round(cfOffsetRef.current + coastDist);
    targetIdx = Math.max(0, Math.min(tracks.length - 1, targetIdx));
    
    setCflowIndex(targetIdx);
    springToIndex(targetIdx, cfVelocity.current);
  };

  const timeStr = time.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const currentProgress = progress * currentTrack.duration;

  const renderScreen = () => {
  const appProps = {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, navigate, goBack, generateShuffleOrder,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio,
    seekTo, scanStorage, clearLibrary, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems, menuRef, dragging, updateSelection, homeMenuItems
  };
    switch (screen) {
      case "home":
        return <HomeScreen {...appProps} />;
      case "music":
        return <ListScreen title="Music" items={musicMenuItems} {...appProps} />;
      case "settings":
        return <SettingsScreen {...appProps} />;
      case "nowplaying":
        return <NowPlayingScreen {...appProps} />;
      case "coverflow":
        return <CoverFlowScreen {...appProps} />;

      case "allsongs":
        return <AllsongsScreen {...appProps} />;

      case "artists":
        return <ArtistsScreen {...appProps} />;

      case "artistSongs":
        return <ArtistSongsScreen {...appProps} />;

      case "albums":
        return <AlbumsScreen {...appProps} />;

      case "albumSongs":
        return <AlbumSongsScreen {...appProps} />;

      case "genres":
        return <GenresScreen {...appProps} />;

      case "genreSongs":
        return <GenreSongsScreen {...appProps} />;

      case "playlists":
        return <PlaylistsScreen {...appProps} />;

      case "playlistSongs":
        return <PlaylistSongsScreen {...appProps} />;

      case "editSong":
        if (!editingTrack) return null;
        return (
          <EditSongScreen
            editingTrack={editingTrack}
            tracks={tracks}
            currentTrack={currentTrack}
            t={t}
            getTrackGenre={getTrackGenre}
            setTracks={setTracks}
            setCurrentTrack={setCurrentTrack}
            saveTracks={saveTracks}
            goBack={goBack}
          />
        );
    }
  };

  const globalTouchStartRef = useRef<{ x: number, y: number } | null>(null);

  return (
    <div
      className="w-screen h-screen min-h-screen flex flex-col overflow-hidden relative"
      style={{
        backgroundColor: t.bg,
        fontFamily: `${FONT_DISPLAY}, ${FONT_BODY}`,
      }}
      onTouchStart={(e) => {
        globalTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        if (!globalTouchStartRef.current) return;
        const dx = e.changedTouches[0].clientX - globalTouchStartRef.current.x;
        const dy = e.changedTouches[0].clientY - globalTouchStartRef.current.y;
        
        // Swipe to go back (right swipe from the left edge)
        if (globalTouchStartRef.current.x < 40 && dx > 60 && Math.abs(dy) < 50) {
          goBack();
        }
        globalTouchStartRef.current = null;
      }}
    >


      {/* Screen content with transition */}
      <motion.div
        key={screen}
        initial={{ opacity: 0, x: screenHistory.length > 0 ? 30 : -30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        className="flex flex-col flex-1 overflow-hidden"
        style={{ minHeight: 0 }}
      >
        {renderScreen()}
      </motion.div>

      {/* Contextual Options Modal */}
      {isOptionsModalOpen && selectedOptionTrack && (
        <div
          className="absolute inset-0 z-50 flex flex-col justify-end"
          style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
          onClick={() => setIsOptionsModalOpen(false)}
        >
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full rounded-t-3xl max-h-[85%] flex flex-col overflow-hidden select-none"
            style={{ backgroundColor: t.secondary }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b text-center" style={{ borderBottomColor: t.divider }}>
              <p className="font-bold truncate" style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: t.fg }}>
                {selectedOptionTrack.title}
              </p>
              <p className="text-xs truncate mt-0.5" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                {selectedOptionTrack.artist}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
              <button
                onClick={() => {
                  setCurrentTrack(selectedOptionTrack);
                  setIsPlaying(true);
                  setProgress(0);
                  setIsOptionsModalOpen(false);
                  navigate("nowplaying");
                }}
                className="w-full px-5 py-4 text-left font-semibold hover:opacity-80 active:bg-white active:bg-opacity-5"
                style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: t.fg }}
              >
                Play Song
              </button>

              <button
                onClick={() => {
                  setEditingTrack(selectedOptionTrack);
                  setIsOptionsModalOpen(false);
                  navigate("editSong");
                }}
                className="w-full px-5 py-4 text-left font-semibold hover:opacity-80 active:bg-white active:bg-opacity-5"
                style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: t.fg }}
              >
                Edit Details
              </button>

              <button
                onClick={() => {
                  setIsOptionsModalOpen(false);
                  setIsPlaylistSelectOpen(true);
                }}
                className="w-full px-5 py-4 text-left font-semibold hover:opacity-80 active:bg-white active:bg-opacity-5"
                style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: t.fg }}
              >
                Add to Playlist
              </button>

              {screen === "playlistSongs" ? (
                <button
                  onClick={() => {
                    setPlaylists(prev => {
                      const list = prev[selectedPlaylistName] || [];
                      const updated = list.filter(id => id !== selectedOptionTrack.id);
                      return { ...prev, [selectedPlaylistName]: updated };
                    });
                    setIsOptionsModalOpen(false);
                    alert(`Removed "${selectedOptionTrack.title}" from playlist.`);
                  }}
                  className="w-full px-5 py-4 text-left font-semibold text-red-500 hover:opacity-80 active:bg-white active:bg-opacity-5"
                  style={{ fontFamily: FONT_DISPLAY, fontSize: 16 }}
                >
                  Remove from Playlist
                </button>
              ) : (
                <button
                  onClick={() => {
                    if (confirm(`Are you sure you want to delete "${selectedOptionTrack.title}" from your library?`)) {
                      const updated = tracks.filter(t => t.id !== selectedOptionTrack.id);
                      setTracks(updated);
                      saveTracks(updated);

                      // Delete art file to prevent leak
                      if (selectedOptionTrack.artLocalPath && selectedOptionTrack.artLocalPath.includes("cover_")) {
                        try {
                          const filename = selectedOptionTrack.artLocalPath.split('/').pop();
                          if (filename) {
                            Filesystem.deleteFile({ path: filename, directory: Directory.Data }).catch(() => { });
                          }
                        } catch (e) { }
                      }

                      if (currentTrack.id === selectedOptionTrack.id) {
                        if (audioRef.current) {
                          audioRef.current.pause();
                          audioRef.current.src = "";
                        }
                        setIsPlaying(false);
                        setProgress(0);
                        if (updated.length > 0) {
                          setCurrentTrack(updated[0]);
                        } else {
                          setCurrentTrack(EMPTY_TRACK);
                        }
                      }

                      // also remove from all playlists
                      setPlaylists(prev => {
                        const copy = { ...prev };
                        Object.keys(copy).forEach(k => {
                          copy[k] = copy[k].filter(id => id !== selectedOptionTrack.id);
                        });
                        return copy;
                      });
                      setIsOptionsModalOpen(false);
                    }
                  }}
                  className="w-full px-5 py-4 text-left font-semibold text-red-500 hover:opacity-80 active:bg-white active:bg-opacity-5"
                  style={{ fontFamily: FONT_DISPLAY, fontSize: 16 }}
                >
                  Delete from Library
                </button>
              )}
            </div>

            <div className="p-4 border-t" style={{ borderTopColor: t.divider }}>
              <button
                onClick={() => setIsOptionsModalOpen(false)}
                className="w-full py-3.5 rounded-xl font-bold text-center active:scale-[0.98] transition-all"
                style={{ backgroundColor: t.tertiary, color: t.fg, fontSize: 15 }}
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Playlist Selector Modal */}
      {isPlaylistSelectOpen && selectedOptionTrack && (
        <div
          className="absolute inset-0 z-50 flex flex-col justify-end"
          style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
          onClick={() => {
            setIsPlaylistSelectOpen(false);
            setIsCreatingModalPlaylist(false);
          }}
        >
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full rounded-t-3xl max-h-[85%] flex flex-col overflow-hidden select-none"
            style={{ backgroundColor: t.secondary }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b text-center" style={{ borderBottomColor: t.divider }}>
              <p className="font-bold" style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: t.fg }}>
                Add to Playlist
              </p>
              <p className="text-xs truncate mt-0.5" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                Select a playlist for "{selectedOptionTrack.title}"
              </p>
            </div>

            <div className="flex-1 overflow-y-auto max-h-[300px]">
              {Object.keys(playlists).length === 0 && (
                <div className="px-6 py-6 text-center">
                  <p style={{ color: t.muted, fontSize: 14, fontFamily: "Inter, sans-serif" }}>No playlists created yet.</p>
                </div>
              )}

              {isCreatingModalPlaylist ? (
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = modalPlaylistName.trim();
                    if (!name) return;
                    setPlaylists(prev => ({
                      ...prev,
                      [name]: [selectedOptionTrack.id]
                    }));
                    alert(`Created "${name}" and added song!`);
                    setIsCreatingModalPlaylist(false);
                    setModalPlaylistName("");
                    setIsPlaylistSelectOpen(false);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-5 py-3 border-b" 
                  style={{ borderBottomColor: t.divider }}
                >
                  <input
                    autoFocus
                    type="text"
                    placeholder="Playlist name..."
                    value={modalPlaylistName}
                    onChange={(e) => setModalPlaylistName(e.target.value)}
                    className="flex-1 px-4 py-2 rounded-lg text-sm border focus:outline-none transition-all duration-200"
                    style={{ backgroundColor: t.tertiary, color: t.fg, borderColor: t.border }}
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg text-sm font-bold active:scale-95 transition-all"
                    style={{ backgroundColor: t.accent, color: t.highlightText }}
                  >
                    +
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setIsCreatingModalPlaylist(true)}
                  className="w-full flex items-center justify-center gap-2 px-6 py-4 border-b font-semibold hover:bg-white hover:bg-opacity-5 active:bg-white active:bg-opacity-10"
                  style={{ borderBottomColor: t.divider, color: t.accent, fontFamily: FONT_DISPLAY, fontSize: 16 }}
                >
                  <span className="text-xl leading-none">+</span> Create New Playlist
                </button>
              )}

              {Object.keys(playlists).map(name => (
                <button
                  key={name}
                  onClick={() => {
                    const list = playlists[name] || [];
                    if (list.includes(selectedOptionTrack.id)) {
                      alert("Song is already in this playlist!");
                    } else {
                      setPlaylists(prev => ({
                        ...prev,
                        [name]: [...list, selectedOptionTrack.id]
                      }));
                      alert(`Added to "${name}" successfully!`);
                    }
                    setIsPlaylistSelectOpen(false);
                  }}
                  className="w-full px-6 py-4 text-left border-b font-medium hover:bg-white hover:bg-opacity-5 active:bg-white active:bg-opacity-10"
                  style={{ borderBottomColor: t.divider, color: t.fg, fontFamily: FONT_DISPLAY, fontSize: 16 }}
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="p-4 border-t" style={{ borderTopColor: t.divider }}>
              <button
                onClick={() => {
                  setIsPlaylistSelectOpen(false);
                  setIsCreatingModalPlaylist(false);
                }}
                className="w-full py-3.5 rounded-xl font-bold text-center active:scale-[0.98] transition-all"
                style={{ backgroundColor: t.tertiary, color: t.fg, fontSize: 15 }}
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </div>
      )}
      {/* Add Songs to Playlist Modal */}
      {isAddSongsToPlaylistOpen && (
        <div
          className="absolute inset-0 z-50 flex flex-col justify-end"
          style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
          onClick={() => setIsAddSongsToPlaylistOpen(false)}
        >
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full rounded-t-3xl max-h-[85%] flex flex-col overflow-hidden select-none"
            style={{ backgroundColor: t.secondary }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b text-center" style={{ borderBottomColor: t.divider }}>
              <p className="font-bold" style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: t.fg }}>
                Add to {selectedPlaylistName}
              </p>
            </div>

            <VirtualizedTrackList
              tracks={tracks}
              renderItem={(track) => {
                const inPlaylist = (playlists[selectedPlaylistName] || []).includes(track.id);
                return (
                  <button
                    onClick={() => {
                      setPlaylists(prev => {
                        const list = prev[selectedPlaylistName] || [];
                        if (list.includes(track.id)) {
                          return { ...prev, [selectedPlaylistName]: list.filter(id => id !== track.id) };
                        } else {
                          return { ...prev, [selectedPlaylistName]: [...list, track.id] };
                        }
                      });
                    }}
                    className="w-full px-5 py-4 flex items-center justify-between border-b transition-colors"
                    style={{ borderBottomColor: t.divider }}
                  >
                    <div className="text-left flex-1 min-w-0 pr-4">
                      <p className="font-semibold truncate" style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: t.fg }}>
                        {track.title}
                      </p>
                      <p className="text-xs truncate mt-0.5" style={{ fontFamily: "Inter, sans-serif", color: t.muted }}>
                        {track.artist}
                      </p>
                    </div>
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center border-2 flex-shrink-0"
                      style={{
                        borderColor: inPlaylist ? t.accent : t.muted,
                        backgroundColor: inPlaylist ? t.accent : "transparent"
                      }}
                    >
                      {inPlaylist && <div className="w-2.5 h-2.5 rounded-full bg-white" />}
                    </div>
                  </button>
                );
              }}
            />

            <div className="p-4 border-t" style={{ borderTopColor: t.divider }}>
              <button
                onClick={() => setIsAddSongsToPlaylistOpen(false)}
                className="w-full py-3.5 rounded-xl font-bold text-center active:scale-[0.98] transition-all"
                style={{ backgroundColor: t.accent, color: t.highlightText, fontSize: 15 }}
              >
                Done
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
