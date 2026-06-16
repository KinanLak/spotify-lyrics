import { useEffect, useRef, useState } from "react";

type LyricLine = {
  time: number;
  text: string;
};

type SpotifyToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

type SpotifyTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  cover?: string;
};

type SpotifySnapshot = {
  track: SpotifyTrack;
  progressMs: number;
  sampledAt: number;
  isPlaying: boolean;
};

const SPOTIFY_CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const SPOTIFY_REDIRECT_URI = import.meta.env.VITE_SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:5173";
const SPOTIFY_SCOPES = "user-read-currently-playing user-read-playback-state";
const TOKEN_KEY = "lyricwave.spotify.token";
const VERIFIER_KEY = "lyricwave.spotify.verifier";
const STATE_KEY = "lyricwave.spotify.state";

function parseLrc(lrc: string): LyricLine[] {
  return lrc
    .split(/\r?\n/)
    .flatMap((rawLine) => {
      const timestamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      if (timestamps.length === 0) return [];

      const lastTimestamp = timestamps[timestamps.length - 1];
      const text = rawLine.slice((lastTimestamp.index ?? 0) + lastTimestamp[0].length).trim();

      return timestamps.map((match) => {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] ? Number(match[3].padEnd(3, "0")) / 1000 : 0;
        return { time: minutes * 60 + seconds + fraction, text };
      });
    })
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.time - b.time);
}

function getActiveIndex(lines: LyricLine[], seconds: number) {
  if (lines.length === 0) return -1;

  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (seconds >= lines[index].time) active = index;
    else break;
  }
  return active;
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const rest = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

// Adaptive font size for the active karaoke line: shorter lines get bigger,
// long lines shrink so they never wrap to three lines.
function karaokeLineSize(length: number) {
  if (length <= 16) return "clamp(2.8rem, 7vw, 7rem)";
  if (length <= 26) return "clamp(2.4rem, 5.6vw, 5.6rem)";
  if (length <= 38) return "clamp(2rem, 4.6vw, 4.6rem)";
  if (length <= 52) return "clamp(1.7rem, 3.6vw, 3.8rem)";
  return "clamp(1.5rem, 3vw, 3.2rem)";
}

function loadToken(): SpotifyToken | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as SpotifyToken;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

function saveToken(token: SpotifyToken) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

function randomString(length = 64) {
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[value % 62]).join("");
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  return crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function exchangeSpotifyCode(code: string) {
  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!SPOTIFY_CLIENT_ID || !verifier) throw new Error("Configuration Spotify incomplete.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error("Connexion Spotify refusee.");
  const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  } satisfies SpotifyToken;
}

async function refreshSpotifyToken(token: SpotifyToken) {
  if (!SPOTIFY_CLIENT_ID || !token.refreshToken) throw new Error("Session Spotify expiree.");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: SPOTIFY_CLIENT_ID,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error("Impossible de rafraichir Spotify.");
  const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  } satisfies SpotifyToken;
}

async function fetchSyncedLyrics(track: SpotifyTrack) {
  const params = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    album_name: track.album,
    duration: String(Math.round(track.durationMs / 1000)),
  });

  const response = await fetch(`https://lrclib.net/api/get?${params}`);
  if (!response.ok) throw new Error("Aucune lyric synchronisee trouvee pour ce titre.");

  const data = (await response.json()) as { syncedLyrics?: string | null; plainLyrics?: string | null };
  if (!data.syncedLyrics) throw new Error("LRCLIB n'a pas de version synchronisee pour ce titre.");
  return parseLrc(data.syncedLyrics);
}

export default function App() {
  const [token, setToken] = useState<SpotifyToken | null>(() => loadToken());
  const [spotifySnapshot, setSpotifySnapshot] = useState<SpotifySnapshot | null>(null);
  const [spotifyLyrics, setSpotifyLyrics] = useState<LyricLine[]>([]);
  const [spotifyStatus, setSpotifyStatus] = useState("Spotify non connecté");
  const [lyricsStatus, setLyricsStatus] = useState("");
  const [toast, setToast] = useState("");
  const [stageMode, setStageMode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  const stageLineRef = useRef<HTMLParagraphElement | null>(null);
  const stageModeRef = useRef<HTMLElement | null>(null);

  const displayLyrics = spotifyLyrics;
  const currentSeconds = spotifySnapshot
    ? Math.min(
        spotifySnapshot.track.durationMs / 1000,
        (spotifySnapshot.progressMs + (spotifySnapshot.isPlaying ? now - spotifySnapshot.sampledAt : 0)) / 1000,
      )
    : 0;
  const durationSeconds = (spotifySnapshot?.track.durationMs ?? 0) / 1000;
  const activeIndex = getActiveIndex(displayLyrics, currentSeconds);
  const progress = durationSeconds > 0 ? Math.min(100, (currentSeconds / durationSeconds) * 100) : 0;
  const isPlaying = Boolean(spotifySnapshot?.isPlaying);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    if (!code) return;

    const expectedState = localStorage.getItem(STATE_KEY);
    window.history.replaceState({}, document.title, window.location.pathname);

    if (returnedState !== expectedState) {
      setSpotifyStatus("Connexion annulee: verification de securite echouee.");
      return;
    }

    exchangeSpotifyCode(code)
      .then((newToken) => {
        saveToken(newToken);
        setToken(newToken);
        setSpotifyStatus("Spotify connecté. Lance un titre dans Spotify.");
      })
      .catch((error: Error) => setSpotifyStatus(error.message))
      .finally(() => {
        localStorage.removeItem(VERIFIER_KEY);
        localStorage.removeItem(STATE_KEY);
      });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  useEffect(() => {
    if (!stageMode) return;
    stageLineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex, stageMode]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!stageMode) return;
    void stageModeRef.current?.requestFullscreen?.().catch(() => undefined);
  }, [stageMode]);

  useEffect(() => {
    function handleFullscreenChange() {
      if (!document.fullscreenElement) setStageMode(false);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") void closeStageMode();
    }

    if (stageMode) document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [stageMode]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const currentToken = token;

    async function ensureToken() {
      if (Date.now() < currentToken.expiresAt - 60_000) return currentToken.accessToken;
      const newToken = await refreshSpotifyToken(currentToken);
      saveToken(newToken);
      setToken(newToken);
      return newToken.accessToken;
    }

    async function pollSpotify() {
      try {
        const accessToken = await ensureToken();
        const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (cancelled) return;

        if (response.status === 204) {
          setSpotifyStatus("Aucun titre en cours. Lance Spotify sur un appareil.");
          return;
        }

        if (!response.ok) throw new Error("Impossible de lire le morceau Spotify en cours.");
        const data = (await response.json()) as {
          progress_ms?: number;
          is_playing?: boolean;
          item?: {
            id?: string;
            name?: string;
            duration_ms?: number;
            artists?: { name: string }[];
            album?: { name?: string; images?: { url: string }[] };
          };
        };

        if (!data.item?.id || !data.item.name || !data.item.duration_ms) {
          setSpotifyStatus("Spotify joue un contenu sans paroles synchronisables.");
          return;
        }

        setSpotifySnapshot({
          track: {
            id: data.item.id,
            title: data.item.name,
            artist: data.item.artists?.map((artist) => artist.name).join(", ") ?? "Artiste inconnu",
            album: data.item.album?.name ?? "",
            durationMs: data.item.duration_ms,
            cover: data.item.album?.images?.[0]?.url,
          },
          progressMs: data.progress_ms ?? 0,
          sampledAt: Date.now(),
          isPlaying: Boolean(data.is_playing),
        });
        setSpotifyStatus(Boolean(data.is_playing) ? "Synchronisation Spotify active" : "Spotify en pause");
      } catch (error) {
        if (!cancelled) setSpotifyStatus(error instanceof Error ? error.message : "Erreur Spotify inconnue.");
      }
    }

    pollSpotify();
    const timer = window.setInterval(pollSpotify, 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    if (!spotifySnapshot) return;

    let cancelled = false;
    setLyricsStatus("Recherche des paroles synchronisées…");
    setSpotifyLyrics([]);

    fetchSyncedLyrics(spotifySnapshot.track)
      .then((lines) => {
        if (cancelled) return;
        setSpotifyLyrics(lines);
        setLyricsStatus("");
        setToast("Paroles synchronisées trouvées");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setSpotifyLyrics([]);
        setLyricsStatus(error.message);
      });

    return () => {
      cancelled = true;
    };
  }, [spotifySnapshot?.track.id]);

  async function connectSpotify() {
    if (!SPOTIFY_CLIENT_ID) {
      setSpotifyStatus("Ajoute VITE_SPOTIFY_CLIENT_ID dans .env pour connecter Spotify.");
      return;
    }

    const verifier = randomString();
    const state = randomString(24);
    const challenge = base64UrlEncode(await sha256(verifier));
    localStorage.setItem(VERIFIER_KEY, verifier);
    localStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: SPOTIFY_CLIENT_ID,
      scope: SPOTIFY_SCOPES,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });

    window.location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  function disconnectSpotify() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setSpotifySnapshot(null);
    setSpotifyLyrics([]);
    setSpotifyStatus("Spotify déconnecté");
  }

  async function closeStageMode() {
    if (document.fullscreenElement) await document.exitFullscreen();
    setStageMode(false);
  }

  const trackTitle = spotifySnapshot?.track.title ?? "En attente de Spotify";
  const trackArtist = spotifySnapshot?.track.artist ?? (token ? "Lance un titre dans Spotify" : "Connecte ton compte pour démarrer");
  const cover = spotifySnapshot?.track.cover;

  const coverArt = cover ? (
    <img src={cover} alt="Pochette de l'album" />
  ) : (
    <span className="cover-mark">♪</span>
  );

  return (
    <>
      {stageMode && (
        <section className="stage" ref={stageModeRef}>
          {cover ? (
            <div className="stage-backdrop" style={{ backgroundImage: `url(${cover})` }} />
          ) : (
            <div className="stage-glow" />
          )}
          <div className="stage-scrim" />

          <header className="stage-head">
            <div className="stage-track">
              <div className="stage-cover">{coverArt}</div>
              <div className="stage-track-text">
                <span className="stage-track-name">{trackTitle}</span>
                <span className="stage-track-artist">
                  <span className={isPlaying ? "live-dot on" : "live-dot"} />
                  {trackArtist}
                </span>
              </div>
            </div>
            <button className="btn ghost" onClick={closeStageMode}>Quitter ✕</button>
          </header>

          {displayLyrics.length > 0 ? (
            <div className="stage-scroll" aria-live="polite">
              {displayLyrics.map((line, index) => {
                const state = index === activeIndex ? "active" : index < activeIndex ? "past" : "future";
                return (
                  <p
                    key={`${line.time}-${line.text}`}
                    ref={index === activeIndex ? stageLineRef : null}
                    className={`stage-line ${state}`}
                    style={index === activeIndex ? { fontSize: karaokeLineSize(line.text.length) } : undefined}
                  >
                    {line.text}
                  </p>
                );
              })}
            </div>
          ) : (
            <div className="stage-empty"><p>En attente des paroles…</p></div>
          )}

          <footer className="stage-foot">
            <span>{formatTime(currentSeconds)}</span>
            <div className="bar"><span style={{ width: `${progress}%` }} /></div>
            <span>{formatTime(durationSeconds)}</span>
          </footer>
        </section>
      )}

      <div className="app">
        <header className="topbar simple">
          <div className="brand">
            <span className="brand-mark">♪</span>
            <span className="brand-name">LyricWave</span>
          </div>

          <div className="topbar-actions">
            {token ? (
              <button className="btn ghost" onClick={disconnectSpotify}>Déconnecter</button>
            ) : (
              <button className="btn accent" onClick={connectSpotify}>Connecter Spotify</button>
            )}
          </div>
        </header>

        <main className="lyrics-view">
          {toast && (
            <div className="toast" role="status">
              <span className="live-dot on" />
              {toast}
            </div>
          )}

          {displayLyrics.length > 0 ? (
            <div className="lyrics-scroll">
              {displayLyrics.map((line, index) => {
                const state = index === activeIndex ? "active" : index < activeIndex ? "past" : "future";
                return (
                  <p
                    key={`${line.time}-${line.text}`}
                    ref={index === activeIndex ? activeLineRef : null}
                    className={`lyric-line ${state}`}
                  >
                    {line.text}
                  </p>
                );
              })}
            </div>
          ) : (
            <div className="lyrics-empty">
              <p className="empty-title">{token ? "Pas de paroles pour l'instant" : "Bienvenue sur LyricWave"}</p>
              <p className="empty-sub">
                {token
                  ? lyricsStatus || spotifyStatus
                  : "Connecte ton compte Spotify, lance un titre, et suis les paroles synchronisées en temps réel."}
              </p>
              {!token && (
                <button className="btn accent" onClick={connectSpotify}>Connecter Spotify</button>
              )}
            </div>
          )}
        </main>

        <footer className="player">
          <div className="player-track">
            <div className="player-cover">{coverArt}</div>
            <div className="player-info">
              <span className="player-title">{trackTitle}</span>
              <span className="player-artist">{trackArtist}</span>
            </div>
          </div>

          <div className="player-center">
            <div className="scrubber">
              <span className="time">{formatTime(currentSeconds)}</span>
              <div className="bar"><span style={{ width: `${progress}%` }} /></div>
              <span className="time">{formatTime(durationSeconds)}</span>
            </div>
          </div>

          <div className="player-actions">
            <button className="btn ghost" onClick={() => setStageMode(true)} disabled={displayLyrics.length === 0}>
              Karaoké
            </button>
          </div>
        </footer>
      </div>
    </>
  );
}
