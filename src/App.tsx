import { ChangeEvent, useEffect, useRef, useState } from "react";

type Source = "demo" | "local" | "spotify";

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

const DEMO_DURATION = 116;
const DEMO_LRC = `[00:00.00]Branche une musique, et les mots prennent vie
[00:07.50]Le tempo trace une ligne dans la nuit
[00:14.20]Chaque phrase remonte au centre de l'ecran
[00:21.30]Comme un karaoké doux, précis, vibrant
[00:29.40]Quand Spotify joue, on suit le morceau
[00:36.20]LRCLIB trouve les paroles au bon tempo
[00:43.40]Si tu preferes, depose ton audio ici
[00:51.20]Ajoute un fichier LRC, tout se synchronise
[00:59.00]La voix avance, la couleur respire
[01:06.50]Les lignes passent, impossible de les perdre
[01:14.00]Un lecteur sobre, vivant, fait pour chanter
[01:22.00]Et garder les lyrics calés sur la musique
[01:31.00]Relance, cherche, importe, teste en direct
[01:39.00]LyricWave garde le fil de chaque seconde
[01:47.00]Fin du couplet, la scène reste allumée`;

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
  const [source, setSource] = useState<Source>("demo");
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [demoTime, setDemoTime] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [localTime, setLocalTime] = useState(0);
  const [localDuration, setLocalDuration] = useState(0);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [manualLrc, setManualLrc] = useState("");
  const [token, setToken] = useState<SpotifyToken | null>(() => loadToken());
  const [spotifySnapshot, setSpotifySnapshot] = useState<SpotifySnapshot | null>(null);
  const [spotifyLyrics, setSpotifyLyrics] = useState<LyricLine[]>([]);
  const [spotifyStatus, setSpotifyStatus] = useState("Spotify non connecte");
  const [lyricsStatus, setLyricsStatus] = useState("Mode demo pret");
  const [stageMode, setStageMode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeLineRef = useRef<HTMLLIElement | null>(null);
  const stageModeRef = useRef<HTMLElement | null>(null);

  const displayLyrics = source === "spotify" ? spotifyLyrics : source === "local" ? parseLrc(manualLrc) : parseLrc(DEMO_LRC);
  const spotifySeconds = spotifySnapshot
    ? Math.min(
        spotifySnapshot.track.durationMs / 1000,
        (spotifySnapshot.progressMs + (spotifySnapshot.isPlaying ? now - spotifySnapshot.sampledAt : 0)) / 1000,
      )
    : 0;
  const currentSeconds = source === "spotify" ? spotifySeconds : source === "local" ? localTime : demoTime;
  const durationSeconds = source === "spotify" ? (spotifySnapshot?.track.durationMs ?? 0) / 1000 : source === "local" ? localDuration : DEMO_DURATION;
  const activeIndex = getActiveIndex(displayLyrics, currentSeconds);
  const activeLine = displayLyrics[activeIndex];
  const previousLine = activeIndex > 0 ? displayLyrics[activeIndex - 1] : undefined;
  const nextLine = activeIndex >= 0 ? displayLyrics[activeIndex + 1] : displayLyrics[0];
  const progress = durationSeconds > 0 ? Math.min(100, (currentSeconds / durationSeconds) * 100) : 0;
  const isPlaying = source === "spotify" ? Boolean(spotifySnapshot?.isPlaying) : source === "local" ? localPlaying : demoPlaying;
  const visibleLyricsStatus = source === "spotify" ? lyricsStatus : source === "local" ? (displayLyrics.length > 0 ? `${displayLyrics.length} lignes LRC importees` : "Importe ou colle un LRC") : "Lyrics de demonstration";

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
        setSource("spotify");
        setSpotifyStatus("Spotify connecte. Lance un titre dans Spotify.");
      })
      .catch((error: Error) => setSpotifyStatus(error.message))
      .finally(() => {
        localStorage.removeItem(VERIFIER_KEY);
        localStorage.removeItem(STATE_KEY);
      });
  }, []);

  useEffect(() => {
    if (source !== "demo" || !demoPlaying) return;

    const timer = window.setInterval(() => {
      setDemoTime((time) => (time >= DEMO_DURATION ? 0 : time + 0.25));
    }, 250);

    return () => window.clearInterval(timer);
  }, [demoPlaying, source]);

  useEffect(() => {
    if (source !== "spotify") return;

    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [source]);

  useEffect(() => {
    if (!audioUrl) return;
    return () => URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

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
    if (source !== "spotify" || !token) return;

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
  }, [source, token]);

  useEffect(() => {
    if (source !== "spotify" || !spotifySnapshot) return;

    let cancelled = false;
    setLyricsStatus("Recherche des paroles synchronisees...");
    setSpotifyLyrics([]);

    fetchSyncedLyrics(spotifySnapshot.track)
      .then((lines) => {
        if (cancelled) return;
        setSpotifyLyrics(lines);
        setLyricsStatus(`${lines.length} lignes synchronisees avec LRCLIB`);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setSpotifyLyrics([]);
        setLyricsStatus(error.message);
      });

    return () => {
      cancelled = true;
    };
  }, [source, spotifySnapshot?.track.id]);

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
    setSpotifyStatus("Spotify deconnecte");
    setSource("demo");
  }

  function handleAudioFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setAudioUrl(URL.createObjectURL(file));
    setLocalTime(0);
    setLocalDuration(0);
    setSource("local");
  }

  async function handleLrcFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setManualLrc(await file.text());
    setSource("local");
  }

  function togglePlayback() {
    if (source === "demo") {
      setDemoPlaying((playing) => !playing);
      return;
    }

    if (source === "local" && audioRef.current) {
      if (audioRef.current.paused) void audioRef.current.play();
      else audioRef.current.pause();
    }
  }

  function seek(seconds: number) {
    if (source === "demo") setDemoTime(seconds);
    if (source === "local" && audioRef.current) audioRef.current.currentTime = seconds;
  }

  async function closeStageMode() {
    if (document.fullscreenElement) await document.exitFullscreen();
    setStageMode(false);
  }

  const trackTitle = source === "spotify" ? spotifySnapshot?.track.title ?? "En attente de Spotify" : source === "local" ? "Ton morceau local" : "Demo LyricWave";
  const trackArtist = source === "spotify" ? spotifySnapshot?.track.artist ?? "Lance un titre dans Spotify" : source === "local" ? "Audio + fichier LRC" : "Synchronisation simulee";
  const cover = spotifySnapshot?.track.cover;

  return (
    <>
      {stageMode && (
        <section className="stage-mode" ref={stageModeRef}>
          <div className="stage-orb stage-orb-one" />
          <div className="stage-orb stage-orb-two" />

          <header className="stage-topline">
            <div className="stage-track">
              <div className="stage-cover">
                {cover ? <img src={cover} alt="Pochette de l'album" /> : <span>LW</span>}
              </div>
              <div>
                <p>{isPlaying ? "Lecture en cours" : "En pause"}</p>
                <h1>{trackTitle}</h1>
                <span>{trackArtist}</span>
              </div>
            </div>
            <button className="ghost-button" onClick={closeStageMode}>Quitter</button>
          </header>

          <div className="stage-lyrics-wrap" aria-live="polite">
            <p className="stage-side-line">{previousLine?.text ?? " "}</p>
            <h2>{activeLine?.text ?? "En attente des paroles"}</h2>
            <p className="stage-side-line next">{nextLine?.text ?? " "}</p>
          </div>

          <footer className="stage-footer">
            <span>{formatTime(currentSeconds)}</span>
            <div className="stage-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
            <span>{formatTime(durationSeconds)}</span>
          </footer>
        </section>
      )}

      <main className="app-shell">
      <section className="hero-card">
        <div className="aurora aurora-one" />
        <div className="aurora aurora-two" />

        <header className="topbar">
          <div>
            <p className="eyebrow">Lyrics synchronises</p>
            <h1>LyricWave</h1>
          </div>
          <div className="topbar-actions">
            <button className="stage-button" onClick={() => setStageMode(true)}>Mode scène</button>
            <div className="source-tabs" aria-label="Sources audio">
              <button className={source === "demo" ? "active" : ""} onClick={() => setSource("demo")}>Demo</button>
              <button className={source === "local" ? "active" : ""} onClick={() => setSource("local")}>Local</button>
              <button className={source === "spotify" ? "active" : ""} onClick={() => setSource("spotify")}>Spotify</button>
            </div>
          </div>
        </header>

        <section className="stage-grid">
          <div className="player-panel glass-panel">
            <div className="cover-wrap">
              {cover ? <img src={cover} alt="Pochette de l'album" /> : <div className="cover-placeholder"><span>LW</span></div>}
              <span className={isPlaying ? "pulse-dot playing" : "pulse-dot"} />
            </div>

            <div className="track-copy">
              <p className="status-pill">{source === "spotify" ? spotifyStatus : source === "local" ? "Mode local" : "Mode demo"}</p>
              <h2>{trackTitle}</h2>
              <p>{trackArtist}</p>
            </div>

            <div className="progress-area">
              <div className="time-row">
                <span>{formatTime(currentSeconds)}</span>
                <span>{formatTime(durationSeconds)}</span>
              </div>
              <input
                type="range"
                min="0"
                max={Math.max(1, durationSeconds)}
                value={Math.min(currentSeconds, Math.max(1, durationSeconds))}
                onChange={(event) => seek(Number(event.target.value))}
                disabled={source === "spotify" || durationSeconds === 0}
                aria-label="Position dans le morceau"
              />
              <div className="progress-glow" style={{ width: `${progress}%` }} />
            </div>

            <div className="controls">
              <button className="primary-control" onClick={togglePlayback} disabled={source === "spotify"}>
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button onClick={() => setStageMode(true)}>Plein écran lyrics</button>
              {token ? <button onClick={disconnectSpotify}>Deconnecter</button> : <button onClick={connectSpotify}>Connecter Spotify</button>}
            </div>

            <audio
              ref={audioRef}
              src={audioUrl ?? undefined}
              onTimeUpdate={(event) => setLocalTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => setLocalDuration(event.currentTarget.duration)}
              onPlay={() => setLocalPlaying(true)}
              onPause={() => setLocalPlaying(false)}
              onEnded={() => { setLocalTime(0); setLocalPlaying(false); }}
            />
          </div>

          <div className="lyrics-panel glass-panel">
            <div className="lyrics-header">
              <div>
                <p className="eyebrow">Live lyrics</p>
                <h2>{displayLyrics[activeIndex]?.text ?? "Pret a chanter"}</h2>
              </div>
              <span>{visibleLyricsStatus}</span>
            </div>

            <ol className="lyrics-list">
              {displayLyrics.length > 0 ? displayLyrics.map((line, index) => (
                <li
                  key={`${line.time}-${line.text}`}
                  ref={index === activeIndex ? activeLineRef : null}
                  className={index === activeIndex ? "active" : index < activeIndex ? "past" : ""}
                >
                  <time>{formatTime(line.time)}</time>
                  <span>{line.text}</span>
                </li>
              )) : (
                <li className="empty-line">
                  <time>0:00</time>
                  <span>Importe un fichier .lrc ou lance un titre Spotify avec lyrics disponibles sur LRCLIB.</span>
                </li>
              )}
            </ol>
          </div>
        </section>
      </section>

      <section className="setup-grid">
        <article className="setup-card">
          <span>01</span>
          <h3>Spotify live</h3>
          <p>Connecte ton compte, lance un titre dans Spotify, puis LyricWave lit la position du morceau et recupere les paroles synchronisees via LRCLIB.</p>
        </article>
        <article className="setup-card">
          <span>02</span>
          <h3>Audio local</h3>
          <p>Teste sans API avec ton propre fichier audio et un fichier LRC. La ligne active suit exactement la position du lecteur.</p>
          <label className="file-button">
            Importer audio
            <input type="file" accept="audio/*" onChange={handleAudioFile} />
          </label>
          <label className="file-button secondary">
            Importer LRC
            <input type="file" accept=".lrc,text/plain" onChange={handleLrcFile} />
          </label>
        </article>
        <article className="setup-card lrc-editor">
          <span>03</span>
          <h3>Coller des lyrics</h3>
          <p>Format attendu: <code>[00:12.34]Une ligne synchronisee</code>.</p>
          <textarea value={manualLrc} onChange={(event) => { setManualLrc(event.target.value); setSource("local"); }} placeholder="[00:00.00]Premiere ligne\n[00:08.40]Deuxieme ligne" />
        </article>
      </section>
      </main>
    </>
  );
}
