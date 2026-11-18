import { formatTime, escapeHTML as h, fileMetadata, nextQueueIndex, shuffleQueueKeys, playlistRowPositions, removePlaylistEntry, matches, emptyLibrary, rankTracks, sortReleases, sortPlaylists, queueEntries, moveQueueEntry, playableSelection, insertUpNext, listeningArtists } from "./core.js";
import { isFileDrag, searchTracks } from "./core.js";
import { nativeRuntime as native, musicRequest } from "./runtime.js";
import { iconNames, appIconPath, restoreAppIcon, selectAppIcon, iconSyncEnabled, setIconSync, syncIconWithTheme } from './app-icon.js';
import { BrowserPlayer, LinuxPlayer, inPreloadWindow, isStreamingAudio } from "./player.js";
import { canDownload, resolveCatalogAudio, spotifyPlaceholder, replaceLibraryTrack, mergePCLibrary, savedTrackMetadata, isDuplicateImport } from "./library.js";
import { coverCollage } from './covers.js';
import { deviceLink } from './link.js';
import { TrackWindows } from './track-window.js';
import { swipeToQueue } from './swipe.js';
import { appLanguage, setLanguage, tr, countLabel, translateStatic } from './i18n.js';

const $ = (selector) => document.querySelector(selector);
const icon = (name, extra = "") => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const nativeAudio = window.UndertoneAudio;
await restoreAppIcon();
const platform = native ? await native.invoke('platform') : 'browser';
const trackWindows = native ? new TrackWindows() : null;
const linuxPlayback = platform === 'linux';
const deviceStorage = linuxPlayback || platform === 'windows' || !!nativeAudio;
const audio = linuxPlayback ? new LinuxPlayer(native) : nativeAudio ? $("#audio") : new BrowserPlayer($("#audio"));
const view = $("#view");
const dialog = $("#dialog");
let library = emptyLibrary();
let db;
let storageReady = false;
let saveChain = Promise.resolve();
let page = "discover";
let searchCategory = "all";
let query = "";
let remoteTracks = [];
let remoteStatus = "loading";
let requestId = 0;
let sort = "added";
let queue = [];
let queueIndex = -1;
let current = null;
let shuffle = false;
let shuffleOrder = [];
let repeat = "off";
let playing = false;
let loading = false;
let playTicket = 0;
let objectURL;
let toastTimer;
let searchTimer;
let importing = false;
let pendingTrack;
let lastNativeError = "";
let lastNativeTrack = "";
let seeking = false;
const tracks = new Map();
const catalogCache = new Map();
const artists = new Map();
const albums = new Map();
const discographies = new Map();
const albumRequests = new Map();
let searchData = { tracks: [], artists: [], albums: [] };
let homeData = { sections: [] };
let catalogError = "";
let videoLoading = false;
let artistSongLimit = 10;
let releaseFilter = "all";
let releaseSort = "date";
let releaseView = "list";
let releaseLimit = 8;
let artistReleaseTab = "all";
let navigationHistory = [];
let recentTimer;
let autoplay = false;
let radioLoading = false;
let nextPreload = null;
let queueSession = '';
let queueAddMode = false;
let draggedQueueKey = '';
const downloadQueue = [];
let activeDownload = null;
let downloadRunning = false;
let downloadsDone = 0;
let downloadsTotal = 0;
let downloadErrors = [];
let spotifyState = null;

function pageId() { return page.slice(page.indexOf(":") + 1); }
function currentArtist() { return artists.get(pageId()); }
function followed(id) { return library.followedArtists.some((a) => a.id === id); }

function registerCatalog(data) {
  for (const t of [...(data.videos || []), ...(data.tracks || [])]) {
    tracks.set(t.id, t);
    for (const a of t.artists || []) if (a.id && !artists.has(a.id)) artists.set(a.id, a);
  }
  for (const a of [...(data.artists || []), ...(data.related || [])]) artists.set(a.id, { ...artists.get(a.id), ...a });
  for (const r of [...(data.albums || []), ...(data.singles || []), ...(data.releases || [])]) albums.set(r.id, { ...r, ...albums.get(r.id) });
  for (const section of data.sections || []) registerCatalog(section);
}

function artistLinks(track) {
  if (!track.artists?.length) return `<span>${h(track.artist)}</span>`;
  return track.artists.map((a) => a.id ? `<button class="artist-link" data-action="open-artist" data-id="${h(a.id)}">${h(a.name)}</button>` : `<span>${h(a.name)}</span>`).join('<span class="artist-comma">, </span>');
}

function artistCard(a) {
  return `<article class="artist-card"><button class="artist-picture art-placeholder" data-action="open-artist" data-id="${h(a.id)}" aria-label="${h(tr('Open {name}', { name: a.name }))}">${art(a)}</button><button class="entity-title" data-action="open-artist" data-id="${h(a.id)}">${h(a.name)}</button><p>${h(tr("Artist"))}</p></article>`;
}

function releaseCard(r) {
  return `<article class="release-card"><div class="release-picture art-placeholder"><button class="art-button" data-action="open-album" data-id="${h(r.id)}" aria-label="${h(tr('Open {name}', { name: r.title }))}">${art(r)}</button><button class="card-play" data-action="play-release" data-id="${h(r.id)}" aria-label="${h(tr('Play {title}', { title: r.title }))}">${icon("play")}</button></div><button class="entity-title" data-action="open-album" data-id="${h(r.id)}">${h(r.title)}</button><p>${h([r.year, tr(r.type)].filter(Boolean).join(" · "))}</p></article>`;
}

function catalogFailure() {
  return `<div class="error-state"><h3>${h(tr("Couldn’t load this music."))}</h3><p>${h(tr(catalogError || "Check your connection and try again."))}</p><button class="secondary-btn" data-action="retry">${h(tr("Try again"))}</button> <button class="secondary-btn" data-view="local">${h(tr("Your local files"))}</button></div>`;
}

function toast(message, timeout = 4500) {
  clearTimeout(toastTimer);
  $("#toast").textContent = tr(message);
  $("#toast").classList.remove("hidden");
  if (timeout) toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), timeout);
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbWrite(store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    if (value === undefined) tx.objectStore(store).delete(key);
    else tx.objectStore(store).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error(tr("Storage was interrupted")));
  });
}

async function loadLibrary() {
  let saved;
  if (native) saved = await native.invoke("load_library");
  else {
    const request = indexedDB.open("undertone", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("library");
      request.result.createObjectStore("files");
    };
    db = await idbRequest(request);
    saved = await idbRequest(db.transaction("library").objectStore("library").get("state"));
  }
  if (saved) {
    if (saved.version !== 1 || !saved.tracks || ![saved.liked, saved.imports, saved.playlists, saved.recent].every(Array.isArray)) throw new Error(tr("Library format could not be read"));
    library = { ...emptyLibrary(), ...saved };
    Object.values(library.tracks).forEach((track) => tracks.set(track.id, track));
    library.followedArtists.forEach(a => artists.set(a.id, a));
  }
  if (deviceStorage) {
    const files = await native.invoke("list_downloads");
    library.downloads = Object.fromEntries(Object.entries(files).map(([id, file]) => [id, { ...library.downloads?.[id], ...file }]));
  }
  storageReady = true;
  audio.volume = Math.max(0, Math.min(1, Number(library.volume) || 0));
  $("#volume").value = audio.volume * 100;
  setRange($("#volume"));
}

function saveLibrary() {
  if (!storageReady) {
    toast(tr("Your library could not be opened. Restart the app before saving changes."));
    return Promise.reject(new Error(tr("Storage unavailable")));
  }
  const keep = new Set([...library.liked, ...library.imports, ...library.recent, ...library.playlists.flatMap((p) => p.trackIds), ...Object.keys(library.downloads || {})]);
  for (const id of Object.keys(library.tracks)) if (!keep.has(id)) delete library.tracks[id];
  const snapshot = structuredClone(library);
  const operation = saveChain.then(() => native ? native.invoke("save_library", { library: snapshot }) : idbWrite("library", "state", snapshot));
  saveChain = operation.catch(() => {});
  return operation.catch((error) => {
    console.error(error);
    toast(tr("Couldn’t save your changes. Check that your device has free space."), 7000);
    throw error;
  });
}

function remember(track) {
  const saved = savedTrackMetadata(track, library.tracks[track.id]);
  tracks.set(saved.id, saved);
  library.tracks[saved.id] = saved;
}

function getTrack(id) {
  if (id?.startsWith("youtube:")) {
    if (page === "search") {
      const result = searchTracks(searchData, searchCategory).find(track => track.id === id);
      if (result) return result;
    }
    if (library.tracks[id]) return library.tracks[id];
  }
  return tracks.get(id) || library.tracks[id];
}
function getTracks(ids) { return ids.map(getTrack).filter(Boolean); }
let likedSource;
let likedIds;
function isLiked(id) {
  // Library edits and sync replace the liked array, so one index serves every visible row.
  if (library.liked !== likedSource) {
    likedSource = library.liked;
    likedIds = new Set(likedSource);
  }
  return likedIds.has(id);
}

function playlistCover(ids) {
  const coverTracks = [];
  for (const id of ids) {
    const track = tracks.get(id) || library.tracks[id];
    if (track) coverTracks.push(track);
    if (coverTracks.length === 4) break;
  }
  return art({ coverTracks });
}
function playlist() { return library.playlists.find((p) => `playlist:${p.id}` === page); }

function art(track, lazy = true) {
  const release = track?.id?.startsWith('mono:album:');
  if (release) track = albums.get(track.id) || track;
  const content = track?.artwork ? `<img class="cover" data-cover src="${h(track.artwork)}" alt="" ${lazy ? 'loading="lazy"' : ""}>` : coverCollage(track);
  return release ? `<span class="album-cover" data-cover-album="${h(track.id)}">${content}</span>` : content;
}

function trackCard(track) {
  return `<article class="track-card ${current?.id === track.id ? "current" : ""}" data-track-id="${h(track.id)}">
    <div class="card-art art-placeholder"><button class="art-button art-placeholder" data-action="play" data-id="${h(track.id)}" aria-label="${h(tr(track.source === "unmatched" ? "Choose a recording for {title}" : "Play {title}", { title: track.title }))}">${art(track)}</button><button class="card-play" data-action="play" data-id="${h(track.id)}" aria-label="${h(tr(track.source === "unmatched" ? "Choose a recording for {title}" : "Play {title}", { title: track.title }))}">${icon("play")}</button></div>
    <button class="card-title" data-action="play" data-id="${h(track.id)}">${h(track.title)}</button><div class="card-artist">${artistLinks(track)}</div>
    <div class="card-genre">${track.source === "local" ? tr("YOUR FILES") : track.album?.title ? h(track.album.title) : track.kind === "video" ? tr("MUSIC VIDEO") : tr("SONG")}</div>
    <button class="icon-btn more-card" data-action="track-menu" data-id="${h(track.id)}" aria-label="${h(tr('More options for {title}', { title: track.title }))}">${icon("more")}</button></article>`;
}

function trackRows(list, albumId = "", playlistPositions = null) {
  if (!list.length) return "";
  const windowed = trackWindows && list.length > 80;
  const row = index => {
    const original = list[index];
    const resolved = original.source === 'unmatched' && spotifyState?.resolved.get(original.id);
    const track = resolved ? getTrack(resolved) || original : original;
    const liked = isLiked(track.id);
    return `
    <div class="track-row ${track.source === "unmatched" ? "unmatched-row" : ""} ${current?.id === track.id ? "current" : ""}" data-track-id="${h(track.id)}" data-track-position="${index}"${windowed ? ` role="listitem" aria-posinset="${index + 1}" aria-setsize="${list.length}"` : ""}${playlistPositions ? ` data-playlist-index="${playlistPositions[index]}"` : ""}>
      <button class="track-number" data-action="play" data-id="${h(track.id)}" data-album-id="${h(albumId)}" aria-label="${h(tr(track.source === "unmatched" ? "Choose a recording for {title}" : "Play {title}", { title: track.title }))}"><span>${index + 1}</span>${icon("play")}</button>
      <div class="row-song"><button class="thumb art-placeholder" data-action="play" data-id="${h(track.id)}" data-album-id="${h(albumId)}" aria-label="${h(tr(track.source === "unmatched" ? "Choose a recording for {title}" : "Play {title}", { title: track.title }))}">${art(track)}</button><div class="song-meta"><button class="song-title" data-action="play" data-id="${h(track.id)}" data-album-id="${h(albumId)}">${h(track.title)}</button><div class="row-artists">${track.source === "unmatched" ? `<span class="unmatched-badge">${h(tr("Choose recording"))}</span>` : ""}${canDownload(track) && library.downloads[track.id]?.nativePath ? `<span class="downloaded-badge">${h(tr("Offline"))}</span>` : ""}${track.explicit ? `<span class="explicit-badge" aria-label="${h(tr("Explicit"))}">E</span>` : ""}${artistLinks(track)}${track.kind === "video" ? `<span class="video-badge">${h(tr("VIDEO"))}</span>` : ""}</div></div></div>
      <span class="row-source">${track.album?.id ? `<button class="album-link" data-action="open-album" data-id="${h(track.album.id)}">${h(track.album.title)}</button>` : track.source === "local" ? tr("Your files · Offline") : track.source === "monochrome" ? "Monochrome" : track.source === "unmatched" ? tr("Spotify import · Choose recording") : track.source === "youtube" ? "YouTube" : "Audius"}</span>
      <span class="row-duration" data-duration-for="${h(track.id)}">${track.duration ? formatTime(track.duration) : "—"}</span><span class="row-actions"><button class="icon-btn add-queue-button" data-action="queue-add-track" data-id="${h(track.id)}" aria-label="${h(tr('Add {title} to queue', { title: track.title }))}" title="${h(tr("Add to queue"))}">${icon("plus")}</button><button class="icon-btn ${liked ? "liked" : ""}" data-action="like" data-id="${h(track.id)}" aria-label="${liked ? tr("Unlike") : tr("Like")} ${h(track.title)}" aria-pressed="${liked}">${icon("heart")}</button><button class="icon-btn" data-action="track-menu" data-id="${h(track.id)}" aria-label="${h(tr('More options for {title}', { title: track.title }))}">${icon("more")}</button></span>
    </div>`;
  };
  const rows = windowed ? trackWindows.placeholder(list.length, row)
    : `<div class="track-list">${list.map((_, index) => row(index)).join("")}</div>`;
  return `<div class="table-heading"><span>#</span><span>${h(tr("TITLE"))}</span><span>${h(tr("ALBUM"))}</span><span>${h(tr("TIME"))}</span><span></span></div>${rows}`;
}

function empty(iconName, title, message, action = "discover", label = tr("Find some music")) {
  return `<div class="empty-state"><div class="mini-cover">${icon(iconName)}</div><h2>${h(title)}</h2><p>${h(message)}</p><button class="primary-btn" data-action="${action}">${h(label)}${icon("arrow")}</button></div>`;
}

function skeleton() {
  return `<div class="track-grid">${Array.from({ length: 5 }, () => '<div><div class="skeleton-art"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>').join("")}</div>`;
}

function renderDiscover() {
  const recent = getTracks(library.recent).slice(0, 6);
  const sections = homeData.sections;
  let content = `<div class="home-heading"><div><h1>${h(tr("Made for you"))}</h1><p>${h(tr("Recommendations from your listening, likes, and followed artists."))}</p></div><button class="secondary-btn" data-action="refresh">${icon("repeat")}${h(tr("Refresh"))}</button></div>`;
  if (recent.length) content += `<div class="recent-tiles" data-context="recent">${recent.map(t => `<div class="recent-tile"><button class="recent-cover art-placeholder" data-action="play" data-id="${h(t.id)}" aria-label="${h(tr('Play {title}', { title: t.title }))}">${art(t)}</button><div><button class="entity-title" data-action="play" data-id="${h(t.id)}">${h(t.title)}</button><div class="card-artist">${artistLinks(t)}</div></div><button class="icon-btn" data-action="play" data-id="${h(t.id)}" aria-label="${h(tr('Play {title}', { title: t.title }))}">${icon("play")}</button></div>`).join("")}</div>`;
  if (!sections.length && remoteStatus === "loading") content += `<div class="music-section">${skeleton()}</div>`;
  if (remoteStatus === "error") content += catalogFailure();
  for (const [index, section] of sections.entries()) {
    const title = section.kind === 'related' ? tr("Related artists") : tr('More from {artist}', { artist: section.artist });
    const body = section.tracks?.length ? `<div class="track-grid">${section.tracks.map(trackCard).join("")}</div>` : `<div class="artist-grid">${(section.artists || []).map(artistCard).join("")}</div>`;
    content += `<section class="music-section" data-context="home:${index}"><div class="section-heading"><h2>${h(title)}</h2></div>${body}</section>`;
  }
  if (remoteStatus === 'ready' && !sections.length) {
    const message = recommendationArtists().length ? 'No more recommendations for these artists.' : 'Play a song, like a track, or follow an artist to get recommendations.';
    content += empty('music', tr('Find music for your home screen'), tr(message), 'focus-search', tr('Search music'));
  }
  if (library.followedArtists.length) content += `<section class="music-section"><div class="section-heading"><h2>${h(tr("Your artists"))}</h2></div><div class="artist-grid">${library.followedArtists.slice(0, 6).map(artistCard).join("")}</div></section>`;
  return content;
}

function renderSearch() {
  if (!query) return `<div class="search-intro"><span class="eyebrow">${h(tr("LESS DIGGING. MORE LISTENING."))}</span><h1>${h(tr("Songs. Artists. Albums."))}</h1><p>${h(tr("Find a recording, explore an artist, or play an entire release."))}</p><div class="search-prompts">${recommendationArtists().map(({ name }) => `<button class="chip" data-action="search-name" data-name="${h(name)}">${icon("search")}${h(name)}</button>`).join("")}</div></div>${library.followedArtists.length ? `<section class="music-section"><div class="section-heading"><h2>${h(tr("Your artists"))}</h2></div><div class="artist-grid">${library.followedArtists.slice(0, 6).map(artistCard).join("")}</div></section>` : ""}`;
  const tabs = [["all", tr("All")], ["songs", tr("Songs")], ["artists", tr("Artists")], ["albums", tr("Albums")], ["videos", tr("Music videos")]];
  const localMatches = getTracks(library.imports).filter(t => matches(t, query));
  const music = searchTracks(searchData, searchCategory);
  const exactArtist = searchData.artists?.find(a => a.name.normalize("NFKC").toLocaleLowerCase() === query.normalize("NFKC").toLocaleLowerCase());
  let output = `<div class="search-page-heading"><div><span class="eyebrow">${h(tr("FIND YOUR SOUND"))}</span><h1>${h(tr('Results for “{query}”', { query }))}</h1></div><span class="search-status">${videoLoading ? `<i class="loading-dot"></i>${h(tr("Checking YouTube for more matches…"))}` : remoteStatus === "ready" ? countLabel(music.length, 'recording') : tr("Searching…")}</span></div><div class="search-filters" aria-label="${h(tr("Search result types"))}">${tabs.map(([value, label]) => `<button class="chip ${searchCategory === value ? "active" : ""}" data-action="search-filter" data-filter="${value}" aria-pressed="${searchCategory === value}">${label}</button>`).join("")}</div>`;
  if (remoteStatus === "loading") return output + skeleton();
  if (remoteStatus === "error") return output + catalogFailure();
  if (searchData.notice) output += `<p class="catalog-notice">${h(tr(searchData.notice))}</p>`;
  if (searchCategory !== 'videos') output += `<button class="text-button fallback-search" data-action="search-youtube">${h(tr("Search YouTube songs too"))}</button>`;
  if (searchCategory === "videos" && videoLoading && !searchData.fallbackLoaded) return output + skeleton();
  if (searchCategory !== "videos" && !music.length && !searchData.artists?.length && !searchData.albums?.length && !localMatches.length) return output + empty("search", tr("No matches for this one."), tr("Try the artist’s name, a shorter title, or another spelling."), "focus-search", tr("Try another search"));
  if (searchCategory === "all") {
    const best = exactArtist || music[0] || searchData.artists?.[0];
    const top = best ? `<section class="top-result"><h2>${h(tr("Top result"))}</h2><article class="top-result-card ${best.name ? "is-artist" : ""}"><button class="top-result-art art-placeholder" data-action="${best.name ? "open-artist" : "play"}" data-id="${h(best.id)}" aria-label="${best.name ? tr("Open") : tr("Play")} ${h(best.name || best.title)}">${art(best)}</button><button class="top-result-name" data-action="${best.name ? "open-artist" : "play"}" data-id="${h(best.id)}">${h(best.name || best.title)}</button><div class="top-result-meta">${best.name ? `<span class="entity-badge">${h(tr("Artist"))}</span>` : `${artistLinks(best)}<span class="entity-badge">${best.kind === "video" ? tr("Music video") : tr("Song")}</span>`}</div><button class="top-result-action" data-action="${best.name ? "open-artist" : "play"}" data-id="${h(best.id)}" aria-label="${best.name ? tr("Open artist") : tr("Play top result")}">${icon(best.name ? "arrow" : "play")}</button></article></section>` : "";
    output += `<div class="search-overview">${top}<section class="search-top-songs"><div class="section-heading"><h2>${h(tr("Songs"))}</h2><button class="text-button" data-action="search-filter" data-filter="songs">${h(tr("Show all"))} ${icon("arrow")}</button></div>${trackRows(music.slice(0, 5))}</section></div>`;
    if (searchData.artists?.length) output += `<section class="music-section"><div class="section-heading"><h2>${h(tr("Artists"))}</h2><button class="text-button" data-action="search-filter" data-filter="artists">${h(tr("Show all"))} ${icon("arrow")}</button></div><div class="artist-grid">${searchData.artists.slice(0, 6).map(artistCard).join("")}</div></section>`;
    if (searchData.albums?.length) output += `<section class="music-section"><div class="section-heading"><h2>${h(tr("Albums & singles"))}</h2><button class="text-button" data-action="search-filter" data-filter="albums">${h(tr("Show all"))} ${icon("arrow")}</button></div><div class="release-grid">${searchData.albums.slice(0, 6).map(releaseCard).join("")}</div></section>`;
  } else if (searchCategory === "artists") output += searchData.artists.length ? `<div class="artist-grid">${searchData.artists.map(artistCard).join("")}</div>` : `<p class="catalog-empty">${h(tr("No artist matches. Try searching only the artist’s name."))}</p>`;
  else if (searchCategory === "albums") output += searchData.albums.length ? `<div class="release-grid">${searchData.albums.map(releaseCard).join("")}</div>` : `<p class="catalog-empty">${h(tr("No album matches for this search."))}</p>`;
  else {
    output += music.length ? trackRows(music) : `<p class="catalog-empty">${videoLoading ? tr("Looking for matching videos…") : searchCategory !== 'videos' ? h(tr('No song matches for this search.')) : `${h(tr('No video results yet.'))} <button class="text-button" data-action="more-videos">${h(tr('Search YouTube videos'))}</button>`}</p>`;
  }
  if (localMatches.length) output += `<section class="music-section" data-context="local-search"><div class="section-heading"><h2>${h(tr("From your files"))}</h2></div>${trackRows(localMatches)}</section>`;
  return output;
}

function renderArtist() {
  const a = currentArtist();
  if (!a?.tracks) return remoteStatus === "error" ? catalogFailure() : `<div class="artist-skeleton"></div>${skeleton()}`;
  const releases = artistReleaseTab === "albums" ? a.albums : artistReleaseTab === "singles" ? a.singles : [...a.albums, ...a.singles];
  return `<section class="artist-hero">${a.banner || a.artwork ? `<img class="artist-hero-image" src="${h(a.banner || a.artwork)}" alt="">` : ""}<div class="artist-hero-shade"></div><div class="artist-hero-text"><span class="artist-kicker">${h(tr("ARTIST"))}</span><h1>${h(a.name)}</h1><p>${a.monthlyListeners ? `<strong>${h(a.monthlyListeners)}</strong> ${h(tr("monthly listeners on Monochrome"))}` : a.subscribers ? `${h(a.subscribers)} YouTube subscribers` : tr("Music on Monochrome")}</p></div></section>
    <div class="artist-body"><div class="artist-controls"><button class="artist-play" data-action="play-all" aria-label="${h(tr('Play {title}', { title: a.name }))}">${icon("play")}</button><button class="secondary-btn follow-button ${followed(a.id) ? "is-following" : ""}" data-action="follow-artist" data-id="${h(a.id)}" aria-pressed="${followed(a.id)}">${followed(a.id) ? icon("check") + "Following" : tr("Follow")}</button><button class="secondary-btn" data-action="artist-radio">${icon("disc")}${h(tr("Artist mix"))}</button><button class="secondary-btn" data-action="artist-videos">${icon("play")}${h(tr("Music videos"))}</button><button class="icon-btn" data-action="artist-about" aria-label="About ${h(a.name)}">${icon("more")}</button></div>
    <section class="artist-popular" data-context="artist"><div class="section-heading"><h2>${h(tr("Popular"))}</h2><span class="source-caption">${h(tr("On Monochrome"))}</span></div>${trackRows(a.tracks.slice(0, artistSongLimit))}${a.tracks.length > artistSongLimit ? `<button class="text-button see-more" data-action="more-artist-songs">${h(tr("Show more"))}</button>` : ""}</section>
    <section class="music-section"><div class="section-heading"><h2>${h(tr("Discography"))}</h2><button class="text-button" data-action="open-discography" data-id="${h(a.id)}">${h(tr("Show all"))} ${icon("arrow")}</button></div><div class="release-tabs">${[["all", tr("Popular releases")], ["albums", tr("Albums")], ["singles", tr("Singles and EPs")]].map(([value, label]) => `<button class="chip ${artistReleaseTab === value ? "active" : ""}" data-action="artist-release-filter" data-filter="${value}" aria-pressed="${artistReleaseTab === value}">${label}</button>`).join("")}</div><div class="release-grid">${releases.slice(0, 6).map(releaseCard).join("")}</div>${!releases.length ? `<p class="catalog-empty">${h(tr("No releases in this category are available from Monochrome."))}</p>` : ""}</section>
    ${a.videos?.length ? `<section class="music-section" data-context="artist-videos"><div class="section-heading"><h2>${h(tr("Music videos"))}</h2></div><div class="track-grid">${a.videos.slice(0, 5).map(trackCard).join("")}</div></section>` : ""}
    ${a.related?.length ? `<section class="music-section"><div class="section-heading"><h2>${h(tr("Fans also like"))}</h2><span class="source-caption">${h(tr("Related artists on Monochrome"))}</span></div><div class="artist-grid">${a.related.slice(0, 6).map(artistCard).join("")}</div></section>` : ""}
    ${a.description ? `<section class="music-section artist-about-section"><div class="section-heading"><h2>${h(tr('About {name}', { name: a.name }))}</h2></div><p>${h(a.description.slice(0, 650))}${a.description.length > 650 ? "…" : ""}</p><button class="text-button see-more" data-action="artist-about">${h(tr("Read more"))}</button></section>` : ""}</div>`;
}

function filteredReleases() {
  const a = currentArtist();
  return sortReleases(discographies.get(pageId())?.releases || [...(a?.albums || []), ...(a?.singles || [])], releaseFilter, releaseSort);
}

function releaseBlock(r) {
  const full = albums.get(r.id);
  return `<section class="release-block" data-release-id="${h(r.id)}"><header class="release-block-header"><button class="release-block-art art-placeholder" data-action="open-album" data-id="${h(r.id)}" aria-label="${h(tr('Open {name}', { name: r.title }))}">${art(r)}</button><div><button class="release-block-title" data-action="open-album" data-id="${h(r.id)}">${h(r.title)}</button><p class="release-meta">${h([tr(r.type), r.year].filter(Boolean).join(" · "))}<span class="release-track-count">${full?.tracks ? ` · ${countLabel(full.tracks.length)}` : ""}</span></p><div class="release-block-actions"><button class="release-play" data-action="play-release" data-id="${h(r.id)}" aria-label="${h(tr('Play {title}', { title: r.title }))}">${icon("play")}</button><button class="icon-btn" data-action="release-queue" data-id="${h(r.id)}" aria-label="Add ${h(r.title)} to queue">${icon("plus")}</button><button class="icon-btn" data-action="download-release" data-id="${h(r.id)}" aria-label="Download ${h(r.title)}">${icon("download")}</button><button class="text-button" data-action="open-album" data-id="${h(r.id)}">${h(tr("Open release"))} ${icon("arrow")}</button></div></div></header><div class="release-tracks" data-album-tracks="${h(r.id)}">${full?.tracks ? trackRows(full.tracks, r.id) : `<div class="release-loading">${h(tr("Loading tracks…"))}</div>`}</div></section>`;
}

function renderDiscography() {
  const a = currentArtist();
  if (!a?.tracks) return remoteStatus === "error" ? catalogFailure() : skeleton();
  const list = filteredReleases();
  return `<div class="discography-heading"><div><button class="artist-back-link" data-action="open-artist" data-id="${h(a.id)}">${h(a.name)}</button><h1>${h(tr("Discography"))}</h1><p>${h(tr("Releases available on Monochrome."))}</p></div><div class="discography-options"><label><span class="sr-only">${h(tr("Release type"))}</span><select id="release-filter" aria-label="${h(tr("Release type"))}"><option value="all" ${releaseFilter === "all" ? "selected" : ""}>${h(tr("All releases"))}</option><option value="albums" ${releaseFilter === "albums" ? "selected" : ""}>${h(tr("Albums"))}</option><option value="singles" ${releaseFilter === "singles" ? "selected" : ""}>${h(tr("Singles and EPs"))}</option></select></label><label><span class="sr-only">${h(tr("Sort releases"))}</span><select id="release-sort" aria-label="${h(tr("Sort releases"))}"><option value="date" ${releaseSort === "date" ? "selected" : ""}>${h(tr("Newest first"))}</option><option value="name" ${releaseSort === "name" ? "selected" : ""}>${h(tr("Name"))}</option></select></label><div class="view-toggle"><button class="icon-btn ${releaseView === "list" ? "on" : ""}" data-action="release-view" data-mode="list" aria-label="${h(tr("List view"))}" aria-pressed="${releaseView === "list"}">${icon("list")}</button><button class="icon-btn ${releaseView === "grid" ? "on" : ""}" data-action="release-view" data-mode="grid" aria-label="${h(tr("Grid view"))}" aria-pressed="${releaseView === "grid"}">${icon("grid")}</button></div></div></div>${remoteStatus === "loading" && !discographies.has(a.id) ? `<div class="inline-loading">${h(tr("Loading the full discography…"))}</div>` : ""}${remoteStatus === "error" ? catalogFailure() : ""}${releaseView === "grid" ? `<div class="release-grid">${list.slice(0, releaseLimit * 2).map(releaseCard).join("")}</div>` : `<div class="discography-list">${list.slice(0, releaseLimit).map(releaseBlock).join("")}</div>`}${!list.length && remoteStatus !== "loading" ? `<p class="catalog-empty">${h(tr("No releases in this category."))}</p>` : ""}${list.length > (releaseView === "grid" ? releaseLimit * 2 : releaseLimit) ? `<button class="secondary-btn load-more" data-action="more-releases">${h(tr("More releases"))}</button>` : ""}`;
}

function renderAlbum() {
  const album = albums.get(pageId());
  if (!album?.tracks) return remoteStatus === "error" ? catalogFailure() : `<div class="album-skeleton"></div>${skeleton()}`;
  return `<section class="album-hero"><div class="album-hero-art art-placeholder">${art(album, false)}</div><div><span class="eyebrow">${h(tr(album.type).toUpperCase())}</span><h1>${h(album.title)}</h1><div class="album-credits">${album.artists.map(a => a.id ? `<button class="artist-link" data-action="open-artist" data-id="${h(a.id)}">${h(a.name)}</button>` : h(a.name)).join(", ")}<span> · ${h(album.year)} · ${countLabel(album.tracks.length)}${album.duration ? ` · ${tr('{minutes} min', { minutes: Math.floor(album.duration / 60) })}` : ""}</span></div></div></section><div class="album-body"><div class="artist-controls"><button class="artist-play" data-action="play-all" aria-label="${h(tr('Play {title}', { title: album.title }))}">${icon("play")}</button><button class="secondary-btn" data-action="shuffle-all">${icon("shuffle")}${h(tr("Shuffle"))}</button><button class="secondary-btn" data-action="release-queue" data-id="${h(album.id)}">${icon("queue")}${h(tr("Add to queue"))}</button><button class="secondary-btn" data-action="download-release" data-id="${h(album.id)}">${icon("download")}${h(tr("Download album"))}</button></div>${trackRows(album.tracks, album.id)}${album.description ? `<p class="album-description">${h(album.description.slice(0, 1000))}</p>` : ""}<p class="catalog-credit">${h(tr("Music and release information from Monochrome."))}</p></div>`;
}

async function ensureAlbum(id, force = false) {
  if (!force && albums.get(id)?.tracks) return albums.get(id);
  if (!force && albumRequests.has(id)) return albumRequests.get(id);
  const request = musicRequest("album", { id, force }).then(album => { albums.set(id, album); registerCatalog(album); return album; }).finally(() => albumRequests.delete(id));
  albumRequests.set(id, request);
  return request;
}

let releaseObserver;
let coverObserver;
function observeReleaseTracks() {
  coverObserver?.disconnect();
  coverObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      coverObserver.unobserve(node);
      const id = node.dataset.coverAlbum;
      if (albums.get(id)?.artwork || albums.get(id)?.tracks) continue;
      ensureAlbum(id).then(album => { if (node.isConnected) node.innerHTML = album.artwork ? art(album).replace(/^<span[^>]*>|<\/span>$/g, '') : coverCollage(album); }).catch(() => {});
    }
  }, { rootMargin: '200px' });
  document.querySelectorAll('[data-cover-album]').forEach(node => coverObserver.observe(node));
  releaseObserver?.disconnect();
  if (!page.startsWith("discography:") || releaseView !== "list") return;
  releaseObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      const id = node.dataset.albumTracks;
      releaseObserver.unobserve(node);
      if (albums.get(id)?.tracks) continue;
      ensureAlbum(id).then(album => {
        if (!node.isConnected) return;
        node.innerHTML = trackRows(album.tracks, id);
        trackWindows?.mount(node);
        const count = node.closest(".release-block").querySelector(".release-track-count");
        count.textContent = ` · ${countLabel(album.tracks.length)}`;
        const cover = node.closest('.release-block').querySelector('[data-cover-album]');
        if (cover && !album.artwork) cover.innerHTML = coverCollage(album);
        updatePlayIcons();
      }).catch(error => { if (node.isConnected) node.innerHTML = `<p class="release-loading">${h(tr(String(error.message || error)))} <button class="text-button" data-action="retry-release" data-id="${h(id)}">${h(tr("Retry"))}</button></p>`; });
    }
  }, { rootMargin: "300px" });
  document.querySelectorAll("[data-album-tracks]").forEach(node => releaseObserver.observe(node));
}

function sortedTracks(ids) {
  const list = getTracks(ids);
  if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "artist") list.sort((a, b) => a.artist.localeCompare(b.artist));
  return list;
}

function collectionTracks() {
  if (page === "liked") return sortedTracks(library.liked);
  if (page === "local") return sortedTracks(library.imports);
  if (page === "downloads") return sortedTracks(Object.keys(library.downloads).filter(id => library.downloads[id]?.nativePath));
  if (page.startsWith("playlist:")) return sortedTracks(playlist()?.trackIds || []);
  if (page === "search") {
    const results = searchTracks(searchData, searchCategory);
    return searchCategory === "videos" ? results : [...getTracks(library.imports).filter(t => matches(t, query)), ...results];
  }
  if (page.startsWith("artist:")) return currentArtist()?.tracks || [];
  if (page.startsWith("album:")) return albums.get(pageId())?.tracks || [];
  if (page.startsWith("discography:")) return filteredReleases().flatMap(r => albums.get(r.id)?.tracks || []);
  return remoteTracks;
}

function renderCollection() {
  const local = page === "local";
  const liked = page === "liked";
  const downloaded = page === "downloads";
  const collection = playlist();
  if (!local && !liked && !downloaded && !collection) return empty("music", tr("This playlist is gone."), tr("There’s more music waiting for you."));
  const title = downloaded ? tr("Downloads") : liked ? tr("Liked songs") : local ? tr("Your music, here.") : collection.name;
  const list = collectionTracks();
  const subtitle = downloaded ? tr("Saved on this device. Playback uses these files before the internet.") : liked ? tr("All the songs that felt like a yes.") : local ? tr("Imported audio saved on this device.") : tr("A little collection, entirely your own.");
  return `<div class="page-heading"><div class="page-heading-row"><div class="collection-cover ${liked ? "heart-cover" : local ? "folder-cover" : ""}">${collection ? art({ tracks: list }) : icon(liked ? "heart" : local ? "folder" : "music")}</div><div><span class="eyebrow">${local ? tr("ALWAYS WITH YOU") : tr("YOUR COLLECTION")}</span><h1>${h(title)}</h1><p>${h(subtitle)}<br>${countLabel(list.length)}</p></div></div></div><div class="page-toolbar"><button class="primary-btn" data-action="play-all" ${!list.some(track => track.source !== "unmatched") ? "disabled" : ""}>${icon("play")}${h(tr("Play all"))}</button>${local ? `<button class="secondary-btn" data-action="import">${icon("plus")}${h(tr("Add music"))}</button>` : `<button class="secondary-btn" data-action="shuffle-all" ${!list.some(track => track.source !== "unmatched") ? "disabled" : ""}>${icon("shuffle")}${h(tr("Shuffle"))}</button>`}${!local && !downloaded && list.length ? `<button class="secondary-btn" data-action="download-collection">${icon("download")}${h(tr("Download all"))}</button>` : ""}${downloaded ? `<button class="secondary-btn" data-action="download-status">${h(tr("Downloads"))}</button>` : ""}${collection ? `<button class="secondary-btn ${collection.pinnedAt ? "on" : ""}" data-action="pin-playlist" data-id="${h(collection.id)}" aria-pressed="${!!collection.pinnedAt}">${icon("pin")}${collection.pinnedAt ? tr("Unpin") : tr("Pin playlist")}</button><button class="icon-btn" data-action="rename-playlist" aria-label="${h(tr("Rename playlist"))}">${icon("edit")}</button><button class="icon-btn" data-action="delete-playlist" aria-label="${h(tr("Delete playlist"))}">${icon("trash")}</button>` : ""}<select id="sort" aria-label="${h(tr("Sort tracks"))}"><option value="added" ${sort === "added" ? "selected" : ""}>${h(tr("Recently added"))}</option><option value="title" ${sort === "title" ? "selected" : ""}>${h(tr("Song title"))}</option><option value="artist" ${sort === "artist" ? "selected" : ""}>${h(tr("Artist"))}</option></select></div>${list.length ? trackRows(list, "", collection ? playlistRowPositions(collection.trackIds, list) : null) : downloaded ? empty("download", tr("Keep your music with you."), tr("Download a song, album, or playlist to play it from this device without streaming."), "discover", tr("Find music")) : empty(local ? "folder" : liked ? "heart" : "music", local ? tr("A home for your own music.") : liked ? tr("Your favorites start here.") : tr("Good playlists start with one song."), local ? tr("Import MP3, FLAC, WAV, M4A, or other audio your device supports. Originals stay right where they are.") : liked ? tr("Tap the heart on anything you love. We’ll keep it here for you.") : tr("Find a track, open its menu, and add it to this playlist."), local ? "import" : "discover", local ? tr("Choose audio files") : tr("Explore music"))}`;
}

function renderLibrary() {
  const cards = sortPlaylists(library.playlists).map(p => `<article class="playlist-card"><button class="playlist-open" data-view="playlist:${h(p.id)}"><span class="mini-cover">${playlistCover(p.trackIds)}</span><span><strong>${h(p.name)}</strong><small>${p.pinnedAt ? 'Pinned · ' : ''}${countLabel(p.trackIds.length)}</small></span></button><button class="icon-btn playlist-pin ${p.pinnedAt ? 'on' : ''}" data-action="pin-playlist" data-id="${h(p.id)}" aria-label="${p.pinnedAt ? tr("Unpin") : tr("Pin")} ${h(p.name)}" aria-pressed="${!!p.pinnedAt}">${icon('pin')}</button></article>`).join('');
  return `<div class="page-heading"><span class="eyebrow">${h(tr("ALL YOUR GOOD THINGS"))}</span><h1>${h(tr("Your library."))}</h1><p>${h(tr("Little collections. Endless possibilities."))}</p><div class="library-shortcuts"><button data-view="liked">${icon("heart")}${h(tr("Liked songs"))} <span class="muted">${library.liked.length}</span></button><button data-view="local">${icon("folder")}${h(tr("Local files"))} <span class="muted">${library.imports.length}</span></button><button data-view="downloads">${icon("download")}${h(tr("Downloads"))} <span class="muted">${Object.values(library.downloads).filter(file => file?.nativePath).length}</span></button><button data-action="spotify-import">${icon("import")}${h(tr("Import Spotify"))}</button><button data-action="device-link">${icon("devices")}${nativeAudio ? tr("Connect PC") : tr("Connect phone")}</button></div></div>${library.followedArtists.length ? `<section class="library-artists"><div class="section-heading"><h2>${h(tr("Artists you follow"))}</h2></div><div class="artist-grid">${library.followedArtists.map(artistCard).join("")}</div></section>` : ""}<div class="section-heading"><div><h2>${h(tr("Your playlists"))}</h2><p>${h(tr("Pinned first · Recently played"))}</p></div><button class="secondary-btn" data-action="create-playlist">${icon("plus")}${h(tr("New playlist"))}</button></div>${library.playlists.length ? `<div class="playlist-cards">${cards}</div>` : empty("music", tr("Make a little collection."), tr("For late nights, long walks, or no reason at all."), "create-playlist", tr("Create a playlist"))}`;
}

function renderSidebar() {
  $("#liked-count").textContent = library.liked.length;
  $("#playlist-nav").innerHTML = sortPlaylists(library.playlists).map((p) => `<button class="playlist-link ${page === `playlist:${p.id}` ? "active" : ""}" data-view="playlist:${h(p.id)}"><span class="mini-cover">${playlistCover(p.trackIds)}</span>${p.pinnedAt ? icon('pin', 'sidebar-pin') : ''}<span>${h(p.name)}</span></button>`).join("");
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === page || button.dataset.view === "library" && (page === "local" || page.startsWith("playlist:"))));
}

function render() {
  trackWindows?.clear();
  document.body.classList.toggle("artist-page", page.startsWith("artist:"));
  document.body.classList.toggle("album-page", page.startsWith("album:"));
  document.body.classList.toggle("discography-page", page.startsWith("discography:"));
  view.innerHTML = page === "discover" ? renderDiscover() : page === "search" ? renderSearch() : page === "library" ? renderLibrary() : page.startsWith("artist:") ? renderArtist() : page.startsWith("discography:") ? renderDiscography() : page.startsWith("album:") ? renderAlbum() : renderCollection();
  if (queueAddMode) view.insertAdjacentHTML('afterbegin', `<div class="queue-add-banner"><span>${h(tr("Use"))} ${icon('plus')} ${h(tr("beside a song to add it to your queue."))}</span><button class="secondary-btn" data-action="queue-add-done">${h(tr("Done"))}</button></div>`);
  const catalogPage = ["discover", "search"].includes(page) || /^(artist|album|discography):/.test(page);
  view.setAttribute("aria-busy", catalogPage && remoteStatus === "loading" && (page !== "search" || !!query));
  document.body.classList.toggle("searching", page === "search");
  $("#clear-search").classList.toggle("hidden", !query);
  if ($("#navigate-back")) $("#navigate-back").disabled = !navigationHistory.length;
  renderSidebar();
  trackWindows?.mount(view);
  observeReleaseTracks();
}

function recommendationArtists() {
  return listeningArtists(getTracks(library.recent), getTracks(library.liked), library.followedArtists);
}

async function loadMoreVideos(ticket = requestId, force = false) {
  const q = query;
  videoLoading = true;
  if (page === "search") render();
  try {
    const canonicalArtists = [...artists.values()].filter(a => a.id.startsWith("mono:artist:") && q.toLocaleLowerCase().includes(a.name.toLocaleLowerCase())).slice(0, 8).map(a => ({ id: a.id, name: a.name }));
    const result = await musicRequest("videos", { query: q, force, artists: canonicalArtists });
    if (ticket !== requestId || page !== "search" || query !== q) return;
    searchData = { ...searchData, videos: rankTracks(result.tracks, q), fallbackLoaded: true };
    registerCatalog(searchData);
    remoteTracks = searchTracks(searchData, searchCategory);
    catalogCache.set(q, searchData);
  } catch (error) {
    if (ticket === requestId && page === "search") toast(tr("Extra video results couldn’t load. The music results are still available."));
  } finally {
    if (ticket === requestId && page === "search") { videoLoading = false; render(); }
  }
}

async function loadCatalog(force = false) {
  const ticket = ++requestId;
  const target = page;
  const q = query;
  catalogError = "";
  videoLoading = false;
  if (target === "search" && !q) { remoteStatus = "ready"; render(); return; }
  remoteStatus = "loading";
  render();
  try {
    if (target === "search") {
      const previous = catalogCache.get(q);
      searchData = previous || { tracks: [], artists: [], albums: [] };
      if (searchCategory === "videos") {
        remoteTracks = searchTracks(searchData, searchCategory);
        remoteStatus = "ready";
        if (force || !searchData.fallbackLoaded) await loadMoreVideos(ticket, force);
        else render();
        return;
      }
      const result = !force && previous?.musicLoaded ? previous : await musicRequest("search", { query: q, force });
      if (ticket !== requestId) return;
      searchData = { ...result, musicLoaded: true };
      const cached = catalogCache.get(q);
      if (!force && cached?.fallbackLoaded) searchData = { ...searchData, videos: cached.videos, fallbackLoaded: true };
      registerCatalog(searchData);
      remoteTracks = searchData.tracks;
      catalogCache.set(q, searchData);
    } else if (target.startsWith("artist:")) {
      const id = target.slice(7);
      const result = !force && artists.get(id)?.tracks ? artists.get(id) : await musicRequest("artist", { id, name: artists.get(id)?.name, force });
      artists.set(id, { ...result, artwork: artists.get(id)?.artwork || result.artwork });
      registerCatalog(result);
      if (ticket !== requestId) return;
      remoteTracks = result.tracks;
    } else if (target.startsWith("discography:")) {
      const id = target.slice(12);
      if (!artists.get(id)?.tracks) {
        const a = await musicRequest("artist", { id, name: artists.get(id)?.name });
        artists.set(id, a);
        registerCatalog(a);
      }
      const result = !force && discographies.has(id) ? discographies.get(id) : await musicRequest("discography", { id, force });
      discographies.set(id, result);
      registerCatalog(result);
      if (ticket !== requestId) return;
    } else if (target.startsWith("album:")) {
      const album = await ensureAlbum(target.slice(6), force);
      if (ticket !== requestId) return;
      remoteTracks = album.tracks;
    } else if (target === "discover") {
      const seeds = recommendationArtists();
      const home = seeds.length ? await musicRequest('home', { artists: seeds, recent: library.recent, force }) : { sections: [] };
      if (ticket !== requestId) return;
      registerCatalog(home);
      homeData = home;
      remoteTracks = home.sections.flatMap(s => s.tracks || []);
    } else { remoteStatus = "ready"; render(); return; }
    if (ticket !== requestId) return;
    remoteStatus = "ready";
    render();
    if (target === "search" && searchCategory === "videos" && !searchData.fallbackLoaded) loadMoreVideos(ticket);
  } catch (error) {
    if (ticket !== requestId) return;
    catalogError = String(error.message || error);
    remoteStatus = "error";
    render();
  }
}

function navigationSnapshot() {
  return { page, sort, query, searchCategory, artistReleaseTab, artistSongLimit, releaseFilter, releaseLimit, scroll: window.scrollY };
}

function navigate(next, remember = true) {
  if (remember && next !== page) navigationHistory.push(navigationSnapshot());
  ++requestId;
  clearTimeout(searchTimer);
  page = next;
  sort = "added";
  artistSongLimit = 10;
  artistReleaseTab = "all";
  releaseLimit = 8;
  if (!next.startsWith("discography:")) releaseFilter = "all";
  document.body.classList.remove("player-expanded");
  if (page !== "search") { query = ""; $("#search").value = ""; }
  remoteStatus = "ready";
  render();
  window.scrollTo({ top: 0 });
  trackWindows?.refresh();
  if (["discover", "search"].includes(page) || /^(artist|album|discography):/.test(page)) loadCatalog();
  if (next === "search") requestAnimationFrame(() => $("#search").focus());
}

function goBack() {
  const previous = navigationHistory.pop();
  if (!previous) return;
  ++requestId;
  clearTimeout(searchTimer);
  page = previous.page;
  sort = previous.sort;
  query = previous.query;
  searchCategory = previous.searchCategory;
  artistReleaseTab = previous.artistReleaseTab;
  artistSongLimit = previous.artistSongLimit;
  releaseFilter = previous.releaseFilter;
  releaseLimit = previous.releaseLimit;
  $("#search").value = query;
  render();
  if (["discover", "search"].includes(page) || /^(artist|album|discography):/.test(page)) {
    const loaded = loadCatalog();
    const restoringRequest = requestId;
    loaded.then(() => {
      if (requestId === restoringRequest) {
        window.scrollTo({ top: previous.scroll });
        trackWindows?.refresh();
      }
    });
  } else {
    window.scrollTo({ top: previous.scroll });
    trackWindows?.refresh();
  }
}

if (platform === 'android') {
  window.undertoneBack = () => {
    if (dialog.open) closeDialog();
    else if (!$('#queue-panel').classList.contains('hidden')) actions.queue();
    else if (document.body.classList.contains('player-expanded')) document.body.classList.remove('player-expanded');
    else if (queueAddMode) actions['queue-add-done']();
    else goBack();
  };
}

function updatePlayIcons() {
  $('#seek').disabled = !current || loading;
  $("#play-pause").innerHTML = icon(playing ? "pause" : "play");
  $("#play-pause").setAttribute("aria-label", playing ? tr("Pause") : tr("Play"));
  $("#play-pause").setAttribute("aria-busy", loading);
  document.querySelectorAll("[data-track-id]").forEach((element) => element.classList.toggle("current", element.dataset.trackId === current?.id));
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

function updatePlayer() {
  $("#now-title").textContent = current?.title || tr("Make yourself at home");
  $("#now-artist").textContent = current?.artist || tr("Pick a track and settle in");
  $("#now-artist").disabled = !current?.artists?.some(a => a.id);
  $("#now-art").innerHTML = current ? art(current, false) : icon("disc");
  $("#now-like").disabled = !current;
  $("#now-like").classList.toggle("liked", !!current && isLiked(current.id));
  $("#now-like").setAttribute("aria-label", current && isLiked(current.id) ? tr("Unlike current song") : tr("Like current song"));
  ["#play-pause", "#previous", "#next"].forEach((selector) => $(selector).disabled = !current);
  $("#seek").disabled = !current;
  $("#duration").textContent = formatTime(current?.duration);
  updatePlayIcons();
  renderQueue();
}

function updateProgress(position = audio.currentTime, duration = audio.duration) {
  const length = Number.isFinite(duration) && duration > 0 ? duration : current?.duration || 0;
  if (!seeking) {
    $("#seek").value = length ? Math.min(1000, position / length * 1000) : 0;
    setRange($("#seek"));
  }
  $("#elapsed").textContent = formatTime(position);
  $("#duration").textContent = formatTime(length);
  if (length && "mediaSession" in navigator && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: length, playbackRate: 1, position: Math.min(length, Math.max(0, position)) }); } catch {}
  }
}

function setRange(input) { input.style.setProperty("--fill", `${Number(input.value) / Number(input.max) * 100}%`); }

function mediaMetadata() {
  if (current && "mediaSession" in navigator && "MediaMetadata" in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.album?.title || (current.source === "local" ? tr("Your music") : current.source === "monochrome" ? "Monochrome" : "Audius"), artwork: current.artwork ? [{ src: current.artwork, sizes: "480x480", type: "image/jpeg" }] : [] });
  }
}

function streamURL(track) {
  return `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(track.remoteId)}/stream?app_name=UndertonePersonal`;
}

function androidQueue() {
  return queue.map(track => ({ ...track, nativePath: track.source === 'local' ? track.nativePath : undefined }));
}

function markPlaylistPlayed(id, time = Date.now()) {
  const p = library.playlists.find(p => p.id === id);
  if (!p || time <= (p.lastPlayedAt || 0)) return false;
  p.lastPlayedAt = time;
  if (page === 'library') render(); else renderSidebar();
  return true;
}

function recordRecent(track, playedAt) {
  remember(track);
  markPlaylistPlayed(track.playlistId, playedAt);
  library.recent = [track.id, ...library.recent.filter((id) => id !== track.id)].slice(0, 20);
  saveLibrary().catch(() => {});
  if (page === "discover") {
    clearTimeout(recentTimer);
    recentTimer = setTimeout(() => { if (page === "discover") loadCatalog(); }, 1800);
  }
}

async function resolvePlaybackSource(track, force = false) {
  if (track.source === 'local') {
    if (native && track.nativePath) return { url: linuxPlayback ? track.nativePath : native.convertFileSrc(track.nativePath) };
    const file = await idbRequest(db.transaction('files').objectStore('files').get(track.fileId));
    if (!file) throw new Error(tr("That imported file is missing. Import it again."));
    const objectURL = URL.createObjectURL(file);
    return { url: objectURL, objectURL };
  }
  if (['monochrome', 'youtube'].includes(track.source)) {
    const result = await resolveCatalogAudio(track, deviceStorage ? native : null, musicRequest, force);
    return { url: result.offline && !linuxPlayback ? native.convertFileSrc(result.url) : result.url, duration: result.duration };
  }
  return { url: streamURL(track) };
}

async function playAt(index, list = queue, force = false, playlistId = null) {
  if (!list[index]) return;
  const ticket = ++playTicket;
  const existingQueue = list === queue;
  const key = list[index].queueKey;
  let bufferedSource;
  if (!nativeAudio && existingQueue && !force && nextPreload && nextPreload.key === key) {
    const request = nextPreload;
    const staged = await request.task;
    if (ticket !== playTicket) return;
    if (staged && request === nextPreload && queue.some(track => track.queueKey === key)) {
      if (linuxPlayback) {
        if (await audio.advance(key) || ticket !== playTicket) return;
      } else if (audio.takePreloaded(key)) {
        bufferedSource = request.source;
        nextPreload = null;
      }
    }
    if (list !== queue) {
      list = queue;
      index = list.findIndex(track => track.queueKey === key);
      if (index < 0) return;
    }
  }
  const selected = playableSelection(list, index);
  list = selected.tracks;
  index = selected.index;
  if (!list.length) { toast(tr("These songs still need a recording. Choose one from a song’s menu.")); return; }
  if (index < 0) index = 0;
  queue = queueEntries(list, playlistId);
  queueIndex = index;
  current = queue[index];
  if (shuffle && !nativeAudio && (!existingQueue || !shuffleOrder.length)) {
    shuffleOrder = shuffleQueueKeys(queue, current.queueKey, shuffleOrder);
  }
  clearPreload();
  queueSession = crypto.randomUUID();
  loading = true;
  if (!bufferedSource) {
    if (!linuxPlayback) audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  updatePlayer();
  updateProgress(0, current.duration);
  if (nativeAudio) {
    nativeAudio.loadQueue(JSON.stringify({ tracks: androidQueue(), index, session: queueSession, language: appLanguage(), shuffle, repeat, volume: audio.muted ? 0 : Number($("#volume").value) / 100 }));
    return;
  }
  try {
    const recording = current;
    const source = bufferedSource ?? await resolvePlaybackSource(recording, force);
    if (ticket !== playTicket) { if (source.objectURL) URL.revokeObjectURL(source.objectURL); return; }
    const duration = bufferedSource && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : source.duration;
    if (duration) {
      recording.duration = duration;
      document.querySelectorAll('[data-duration-for]').forEach(node => { if (node.dataset.durationFor === recording.id) node.textContent = formatTime(duration); });
    }
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = source.objectURL;
    if (!bufferedSource) audio.setSource(source.url, recording.queueKey);
    mediaMetadata();
    await audio.play();
    if (ticket !== playTicket) return;
    recordRecent(current);
    primeNextTrack();
  } catch (error) {
    if (ticket !== playTicket) return;
    console.error(error);
    toast(error.name === "NotAllowedError" ? tr("Tap play to start listening.") : current.source === "local" ? tr("This file couldn’t play. Try an MP3, or import the file again.") : String(error.message || error || tr("This recording is unavailable right now.")), 6500);
  } finally {
    if (ticket === playTicket) { loading = false; updatePlayIcons(); }
  }
}

async function togglePlayback() {
  if (!current) return;
  if (nativeAudio) {
    const state = JSON.parse(nativeAudio.state());
    if (state.index < 0) await playAt(queueIndex);
    else nativeAudio.command("toggle", "");
    return;
  }
  if (loading) { ++playTicket; loading = false; audio.pause(); updatePlayIcons(); return; }
  if (audio.paused) {
    if (linuxPlayback && audio.entry !== current.queueKey) { await playAt(queueIndex); return; }
    if (audio.error && ["monochrome", "youtube"].includes(current.source)) { await playAt(queueIndex, queue, true); return; }
    if (!audio.src) { await playAt(queueIndex); return; }
    try { await audio.play(); if (markPlaylistPlayed(current.playlistId)) saveLibrary().catch(() => {}); } catch { toast(tr("Couldn’t start this track. Choose it again to retry.")); }
  } else audio.pause();
}

async function step(direction, ended = false) {
  if (!current) return;
  if (nativeAudio) { nativeAudio.command(direction > 0 ? "next" : "previous", ""); return; }
  if (direction < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const index = nextQueueIndex(queue, queueIndex, shuffle && shuffleOrder, { direction, repeat, ended });
  if (index >= 0) return playAt(index);
  else if (direction > 0 && autoplay && current.source === "monochrome") extendRadio();
  else if (ended) { playing = false; updatePlayIcons(); }
  else if (direction < 0) audio.currentTime = 0;
  else toast(tr("You’ve reached the end of your queue."));
}

function clearPreload() {
  const request = nextPreload;
  if (!request) return;
  nextPreload = null;
  audio.prepareNext(null).catch(() => {});
  if (request.source?.objectURL) URL.revokeObjectURL(request.source.objectURL);
}

function primeNextTrack() {
  if (nativeAudio || !current || audio.entry !== current.queueKey) return;
  if (navigator.onLine === false || !isStreamingAudio(audio.src)) { clearPreload(); return; }
  const inWindow = inPreloadWindow(audio);
  if (!nextPreload && !inWindow) return;
  const index = nextQueueIndex(queue, queueIndex, shuffle && shuffleOrder, { repeat, ended: true });
  const upcoming = queue[index];
  if (nextPreload?.key === upcoming?.queueKey && nextPreload?.fromKey === current.queueKey) return;
  clearPreload();
  if (!inWindow || !upcoming) return;
  const request = { key: upcoming.queueKey, fromKey: current.queueKey };
  nextPreload = request;
  request.task = (async () => {
    try {
      const source = await resolvePlaybackSource(upcoming);
      if (request !== nextPreload || navigator.onLine === false) {
        if (source.objectURL) URL.revokeObjectURL(source.objectURL);
        return false;
      }
      request.source = source;
      await audio.prepareNext({ key: request.key, url: source.url });
      return request === nextPreload;
    } catch { return false; }
  })();
}

function renderQueue() {
  if (native && $("#queue-panel").classList.contains("hidden")) {
    $("#queue-content").replaceChildren();
    return;
  }
  $("#queue-content").innerHTML = `<button class="secondary-btn queue-add-button" data-action="queue-add">${icon('plus')}${h(tr("Add songs"))}</button><p class="queue-hint">${h(tr(nativeAudio ? "Use the arrow buttons to reorder songs." : "Drag to reorder, or use the arrow buttons."))}</p>` + (!queue.length ? `<p class="queue-empty">${h(tr("Add songs from Search or any song’s menu."))}</p>` : `${queueIndex > 0 ? `<p class="queue-caption">${h(tr("EARLIER"))}</p>` : ''}${queue.map((track, index) => `${index === queueIndex ? `<p class="queue-caption">${h(tr("NOW PLAYING"))}</p>` : index === queueIndex + 1 ? `<p class="queue-caption">${h(tr("UP NEXT"))}</p>` : ''}<div class="queue-item ${index === queueIndex ? 'current' : ''}" draggable="true" data-queue-key="${h(track.queueKey)}"><button class="queue-track" data-action="queue-play" data-index="${index}"><span class="thumb art-placeholder">${art(track)}</span><div><strong>${h(track.title)}</strong><small>${h(track.artist)} · ${formatTime(track.duration)}</small></div></button><div class="queue-controls"><button class="icon-btn" data-action="queue-move" data-index="${index}" data-direction="-1" aria-label="${h(tr('Move {title} up', { title: track.title }))}" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="icon-btn" data-action="queue-move" data-index="${index}" data-direction="1" aria-label="${h(tr('Move {title} down', { title: track.title }))}" ${index === queue.length - 1 ? 'disabled' : ''}>${icon('down')}</button>${index !== queueIndex ? `<button class="icon-btn" data-action="queue-remove" data-index="${index}" aria-label="${h(tr('Remove {title} from queue', { title: track.title }))}">${icon('close')}</button>` : ''}</div></div>`).join('')}`);
  $("#queue-content").insertAdjacentHTML("afterbegin", `<button class="autoplay-switch" data-action="autoplay" aria-pressed="${autoplay}"><span>${h(tr("Autoplay artist mix"))}</span><span>${autoplay ? tr("On") : tr("Off")}</span></button>`);
}

function syncQueue() {
  if (shuffle && !nativeAudio) shuffleOrder = shuffleQueueKeys(queue, current?.queueKey, shuffleOrder);
  if (nativeAudio && current) nativeAudio.replaceQueue(JSON.stringify({ tracks: androidQueue(), index: queueIndex, session: queueSession, shuffle, repeat }));
  else primeNextTrack();
  updatePlayer();
}

function enqueueTracks(list) {
  const added = queueEntries(list);
  if (!added.length) { toast(tr("Choose a recording for this song first.")); return; }
  added.forEach(remember);
  const inserted = insertUpNext(queue, queueIndex, added, Boolean(queueSession && current));
  queue = inserted.queue;
  queueIndex = inserted.index;
  current = queue[queueIndex];
  const wasShuffled = shuffle;
  if (shuffle) { shuffle = false; updateModes(); }
  syncQueue();
  toast(wasShuffled ? tr("Added to play next. Shuffle turned off.") : tr("Added to play next."));
}

function reorderQueue(from, to) {
  if (from === to || ![from, to].every(n => Number.isInteger(n) && n >= 0 && n < queue.length)) return;
  const direction = document.activeElement?.dataset.action === 'queue-move' ? document.activeElement.dataset.direction : null;
  const result = moveQueueEntry(queue, queueIndex, from, to);
  queue = result.queue; queueIndex = result.index;
  if (shuffle) { shuffle = false; updateModes(); toast(tr("Queue reordered. Shuffle turned off.")); }
  syncQueue();
  if (direction) document.querySelector(`[data-action="queue-move"][data-index="${to}"][data-direction="${direction}"]:not(:disabled)`)?.focus({ preventScroll: true });
}

async function pinPlaylist(id) {
  const p = library.playlists.find(p => p.id === id);
  if (!p) return;
  p.pinnedAt = p.pinnedAt ? 0 : Date.now();
  await saveLibrary(); render();
}

async function likeTrack(id, track = getTrack(id)) {
  if (!storageReady) { toast(tr("Restart the app to reopen your library before making changes.")); return; }
  if (!track) return;
  const liked = isLiked(id);
  remember(track);
  library.liked = liked ? library.liked.filter((item) => item !== id) : [id, ...library.liked];
  try { await saveLibrary(); toast(liked ? tr("Removed from liked songs") : tr("A good one. Added to liked songs.")); } catch {}
  render();
  updatePlayer();
}

function closeDialog() { dialog.dataset.kind = ""; dialog.close(); }
function openDialog(content, kind = "") { dialog.dataset.kind = kind; dialog.innerHTML = content; if (!dialog.open) dialog.showModal(); }
function dialogTop(title) { return `<div class="dialog-top"><h2 id="dialog-title">${h(title)}</h2><button class="icon-btn" data-action="close-dialog" aria-label="${h(tr("Close dialog"))}">${icon("close")}</button></div>`; }

function appearanceDialog() {
  const currentTheme = document.documentElement.dataset.theme;
  const sync = iconSyncEnabled();
  const choices = Object.entries(window.undertoneAppearance.names).map(([id, name]) => `
    <label class="theme-choice">
      <input type="radio" name="theme" value="${id}" ${id === currentTheme ? 'checked autofocus' : ''}>
      <span class="theme-card">
        <span class="theme-preview" data-theme-preview="${id}" aria-hidden="true">
          <span class="theme-sleeve">${icon('disc')}</span><span class="theme-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
        </span>
        <span class="theme-label">${h(tr(name))}${icon('check')}</span>
      </span>
    </label>`).join('');
  const icons = Object.entries(iconNames).map(([id, name]) => `
    <label class="theme-choice icon-choice">
      <input type="radio" name="app-icon" value="${id}" ${id === document.documentElement.dataset.appIcon ? 'checked' : ''} ${sync ? 'disabled' : ''}>
      <span class="theme-card icon-card">
        <img src="${appIconPath(id)}" alt="" width="40" height="40">
        <span>${h(tr(name))}</span>${icon('check')}
      </span>
    </label>`).join('');
  openDialog(`${dialogTop(tr('Appearance'))}
    <h3 class="appearance-heading" id="theme-heading">${h(tr('Theme'))}</h3>
    <div class="theme-choices" role="radiogroup" aria-labelledby="theme-heading">${choices}</div>
    <h3 class="appearance-heading icon-heading" id="app-icon-heading">${h(tr('App icon'))}</h3>
    <label class="icon-sync">
      <input type="checkbox" name="sync-app-icon" aria-controls="app-icon-choices" ${sync ? 'checked' : ''}>
      <span>${h(tr('Sync with theme'))}</span>
      <img src="${appIconPath()}" data-app-icon alt="" width="30" height="30">
    </label>
    <div class="app-icon-choices" id="app-icon-choices" role="radiogroup" aria-labelledby="app-icon-heading" ${sync ? 'hidden' : ''}>${icons}</div>
    <p class="app-icon-error" role="alert"></p>`, 'appearance');
}

function languageDialog() {
  const currentLanguage = appLanguage();
  openDialog(`${dialogTop(tr('App language'))}<div class="dialog-menu">${[['en', 'English'], ['ru', 'Русский']].map(([lang, name]) => `<button class="menu-item" data-action="set-language" data-lang="${lang}" lang="${lang}" aria-pressed="${lang === currentLanguage}">${name}${lang === currentLanguage ? icon('check') : ''}</button>`).join('')}</div>`, 'language');
}

function changeLanguage(lang) {
  setLanguage(lang);
  translateStatic(document);
  nativeAudio?.command('language', appLanguage());
  updateVolume();
  updateModes();
  updatePlayer();
  render();
  languageDialog();
}

function playlistDialog(rename = false) {
  const p = rename ? playlist() : null;
  openDialog(`${dialogTop(rename ? tr("Give it a new name.") : tr("Make a little collection."))}<p class="dialog-description">${h(tr("A soundtrack for whatever you have in mind."))}</p><form id="playlist-form" data-rename="${p?.id || ""}"><label class="dialog-field" for="playlist-name">${h(tr("PLAYLIST NAME"))}</label><input class="dialog-input" id="playlist-name" maxlength="80" required value="${h(p?.name || "")}" placeholder="${h(tr("Something for the late nights"))}"><div class="dialog-buttons"><button type="button" class="secondary-btn" data-action="close-dialog">${h(tr("Cancel"))}</button><button class="primary-btn" type="submit">${rename ? tr("Save name") : tr("Create playlist")}</button></div></form>`);
  requestAnimationFrame(() => $("#playlist-name").focus());
}

function trackMenu(id, playlistIndex) {
  const track = getTrack(id);
  if (!track) return;
  pendingTrack = id;
  openDialog(`${dialogTop(track.title)}<p class="dialog-description">${h(track.artist)}</p><div class="dialog-menu">${track.source === "unmatched" ? `<button class="menu-item" data-action="find-spotify-match" data-id="${h(track.id)}">${icon("search")}${h(tr("Choose a recording"))}</button>` : ""}${canDownload(track) ? `<button class="menu-item" data-action="${library.downloads[track.id]?.nativePath ? "remove-download" : "download-track"}" data-id="${h(track.id)}">${icon("download")}${library.downloads[track.id]?.nativePath ? tr("Remove download") : tr("Download for offline listening")}</button>` : ""}<button class="menu-item" data-action="add-queue">${icon("queue")}${h(tr("Add to queue"))}</button><button class="menu-item" data-action="menu-like">${icon("heart")}${isLiked(id) ? tr("Remove from liked songs") : tr("Add to liked songs")}</button>${track.source === "monochrome" ? `<button class="menu-item" data-action="track-radio">${icon("disc")}${h(tr("Start artist mix"))}</button>${track.artists?.some(a => a.id) ? `<button class="menu-item" data-action="menu-artist">${icon("music")}${h(tr("Go to artist"))}</button>` : ""}${track.album?.id ? `<button class="menu-item" data-action="menu-album">${icon("disc")}${h(tr("Go to album"))}</button>` : ""}` : ""}<div class="menu-subtitle">${h(tr("ADD TO A PLAYLIST"))}</div>${library.playlists.map((p) => `<button class="menu-item" data-action="add-playlist-track" data-id="${h(p.id)}">${icon("music")}${h(p.name)}${p.trackIds.includes(id) ? icon("check") : ""}</button>`).join("")}<button class="menu-item" data-action="create-for-track">${icon("plus")}${h(tr("Create new playlist"))}</button>${playlist()?.trackIds[playlistIndex] === id ? `<div class="menu-subtitle">${h(tr("THIS PLAYLIST"))}</div><button class="menu-item" data-action="remove-playlist-track" data-index="${playlistIndex}">${icon("trash")}${h(tr("Remove from playlist"))}</button>` : ""}${track.source === "local" ? `<div class="menu-subtitle">${h(tr("LOCAL FILE"))}</div><button class="menu-item danger" data-action="remove-local">${icon("trash")}${h(tr("Remove imported copy"))}</button>` : ""}</div>`);
}

async function addTrackToPlaylist(playlistId, trackId) {
  const p = library.playlists.find((item) => item.id === playlistId);
  const track = getTrack(trackId);
  if (!p || !track) return;
  if (p.trackIds.includes(trackId)) { closeDialog(); toast(tr("That song is already in this playlist.")); return; }
  remember(track);
  p.trackIds.push(trackId);
  await saveLibrary();
  closeDialog();
  toast(tr('Added to {playlist}', { playlist: p.name }));
  render();
}

function about() {
  const version = nativeAudio ? window.UndertoneDevice.appVersion() : "0.0.6-alpha";
  openDialog(`${dialogTop(tr("A space of your own."))}<div class="about-brand"><img data-app-icon src="${appIconPath()}" width="44" height="44" alt=""><h2>undertone.</h2></div><div class="about-list"><div><strong>${h(tr("Music, with less noise."))}</strong>${h(tr("No app account, ads, or subscription."))}</div><div><strong>${h(tr("Search Monochrome."))}</strong>${h(tr("Songs, artists, albums, and release tracks come from its public Tracks catalog."))}</div><div><strong>${h(tr("YouTube when a song is missing."))}</strong>${h(tr("Search and Spotify matching try YouTube if Monochrome has no match. Music videos have their own tab."))}</div><div><strong>${h(tr("Artist mixes."))}</strong>${h(tr("Your listening and likes choose an artist, then mix more of their catalog. This source doesn’t currently provide similar-artist recommendations."))}</div><div><strong>${h(tr("Sound that follows your computer."))}</strong>${h(tr("Undertone has its own volume channel and uses your system’s default output."))}</div><div><strong>${h(tr("Listen offline."))}</strong>${h(tr("Download songs, albums, or playlists. Saved audio is used before an internet stream."))}</div><div><strong>${h(tr("Bring your Spotify library."))}</strong>${h(tr("Import playlists and Liked Songs from account-data JSON/ZIP files or playlist CSVs. Unmatched songs stay visible for review."))}</div><div><strong>${h(tr("Your collection stays yours."))}</strong>${h(tr("Imported files, downloads, and your library stay on this device. Connect your phone and PC to copy them over Wi-Fi."))}</div><div><strong>${h(tr("A few shortcuts."))}</strong>${h(tr("Space to play or pause. / to search. M to mute."))}</div></div><p class="about-version">Undertone Alpha ${h(version)} · ${nativeAudio ? "Android" : platform === "windows" ? "Windows" : "Linux"}</p>`);
}

async function metadata(file) {
  return new Promise((resolve) => {
    const probe = new Audio();
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      probe.removeAttribute("src");
      probe.load();
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    const timer = setTimeout(finish, 5000);
    probe.onloadedmetadata = probe.onerror = finish;
    probe.preload = "metadata";
    probe.src = url;
  });
}

async function importFiles(files) {
  if (importing) return;
  if (!storageReady) { toast(tr("Your library could not be opened. Restart before importing files.")); return; }
  const valid = [...files].filter((file) => /\.(mp3|flac|wav|ogg|m4a|aac|opus|aiff|aif|weba|webm)$/i.test(file.name) || file.type.startsWith("audio/"));
  if (!valid.length) { toast(tr("Choose audio files such as MP3, FLAC, WAV, or M4A.")); return; }
  importing = true;
  let added = 0, duplicates = 0, failed = 0;
  $("#file-input").disabled = true;
  document.querySelectorAll('[data-action="import"]').forEach((button) => button.setAttribute("aria-busy", "true"));
  for (const [index, file] of valid.entries()) {
    toast(tr('Importing audio… {done} / {total}', { done: index + 1, total: valid.length }), 0);
    try {
      if (file.size === 0 || file.size > 256 * 1024 * 1024) throw new Error(tr("File must be between 1 byte and 256 MB"));
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const id = `local:${hash}`;
      const listed = library.imports.includes(id);
      const previous = library.tracks[id];
      if (await isDuplicateImport(listed, previous, file.size, platform === "android" ? native : null)) {
        duplicates++;
        continue;
      }
      const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "audio";
      const fileId = previous?.fileId || `${hash}.${extension}`;
      const duration = previous?.duration || await metadata(file);
      const nativePath = native ? await native.invoke("save_audio", new Uint8Array(bytes), { headers: { "x-audio-id": fileId } }) : undefined;
      if (!native) await idbWrite("files", fileId, file);
      const track = { ...fileMetadata(file.name), genre: "Your files", artwork: "", ...previous, id, fileId, source: "local", duration, nativePath };
      remember(track);
      if (!listed) library.imports.unshift(id);
      await saveLibrary();
      added++;
    } catch (error) { console.error(error); failed++; }
  }
  importing = false;
  $("#file-input").disabled = false;
  $("#file-input").value = "";
  navigate("local");
  const summary = [tr('Imported {count}.', { count: countLabel(added) }), duplicates ? tr('Already in your library: {count}', { count: duplicates }) : "", failed ? tr('Could not import: {count}', { count: failed }) : ""].filter(Boolean).join(" · ");
  toast(summary, failed ? 8500 : 5000);
  document.querySelectorAll('[data-action="import"]').forEach((button) => button.removeAttribute("aria-busy"));
}

async function removeLocal(id) {
  const track = getTrack(id);
  if (!track || track.source !== "local") return;
  if (current?.id === id) {
    ++playTicket;
    clearPreload();
    audio.pause();
    audio.removeAttribute("src");
    if (nativeAudio) nativeAudio.command("stop", "");
    current = null;
    playing = loading = false;
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
  }
  const activeKey = current?.queueKey;
  queue = queue.filter((item) => item.id !== id);
  queueIndex = activeKey ? queue.findIndex((item) => item.queueKey === activeKey) : -1;
  library.imports = library.imports.filter((item) => item !== id);
  library.liked = library.liked.filter((item) => item !== id);
  library.recent = library.recent.filter((item) => item !== id);
  library.playlists.forEach((p) => p.trackIds = p.trackIds.filter((item) => item !== id));
  delete library.tracks[id];
  tracks.delete(id);
  await saveLibrary();
  syncQueue();
  if (native) await native.invoke("delete_audio", { id: track.fileId });
  else await idbWrite("files", track.fileId, undefined);
  closeDialog();
  render();
  updatePlayer();
  toast(tr("Imported copy removed. Your original file is untouched."));
}

function playbackContext(button) {
  const albumId = button.dataset.albumId;
  if (albumId && albums.get(albumId)?.tracks) return albums.get(albumId).tracks;
  const context = button.closest("[data-context]")?.dataset.context;
  if (context === "recent") return getTracks(library.recent);
  if (context === "artist-videos") return currentArtist()?.videos || [];
  if (context === "local-search") return getTracks(library.imports).filter(t => matches(t, query));
  if (context?.startsWith("home:")) return homeData.sections[Number(context.slice(5))]?.tracks || [];
  return collectionTracks();
}

async function playRelease(id) {
  const ticket = ++playTicket;
  loading = true;
  updatePlayIcons();
  try {
    const album = await ensureAlbum(id);
    if (ticket !== playTicket) return;
    if (album.tracks.length) await playAt(0, album.tracks);
    else toast(tr("No playable recordings are available for this release."));
  } finally { if (ticket === playTicket) { loading = false; updatePlayIcons(); } }
}

async function startRadio(seed) {
  if (!seed || seed.source !== "monochrome") { toast(tr("Choose a Monochrome recording to start an artist mix.")); return; }
  const ticket = ++playTicket;
  loading = true;
  updatePlayIcons();
  toast(tr('Building a mix around {artist}…', { artist: seed.artist }));
  try {
    const result = await musicRequest("recommendations", { seed: seed.remoteId, track: seed });
    if (ticket !== playTicket) return;
    registerCatalog(result);
    autoplay = true;
    await playAt(0, [seed, ...result.tracks.filter(t => t.id !== seed.id)]);
    toast(tr("Artist mix is ready. More recordings are in your queue."));
  } finally { if (ticket === playTicket) { loading = false; updatePlayIcons(); } }
}

async function extendRadio() {
  if (radioLoading || !current) return;
  const ticket = playTicket;
  radioLoading = loading = true;
  updatePlayIcons();
  try {
    const result = await musicRequest("recommendations", { seed: current.remoteId, track: current });
    if (ticket !== playTicket) return;
    const seen = new Set(queue.map(t => t.id));
    const additional = result.tracks.filter(t => !seen.has(t.id));
    if (!additional.length) { toast(tr("You’ve reached the end of this artist mix.")); return; }
    registerCatalog(result);
    const index = queue.length;
    await playAt(index, [...queue, ...additional]);
  } catch (error) { toast(String(error.message || error)); }
  finally { radioLoading = false; if (ticket === playTicket) { loading = false; updatePlayIcons(); } }
}

async function followArtist(id) {
  if (!storageReady) { toast(tr("Your library needs to be reopened before saving changes.")); return; }
  const a = artists.get(id);
  if (!a) return;
  if (followed(id)) library.followedArtists = library.followedArtists.filter(item => item.id !== id);
  else library.followedArtists.unshift({ id: a.id, name: a.name, artwork: a.artwork, seedTrack: a.tracks?.[0] || null });
  await saveLibrary();
  render();
  toast(followed(id) ? tr('Following {artist}.', { artist: a.name }) : tr('Unfollowed {artist}.', { artist: a.name }));
}

function searchName(name, category = "all") {
  if (page !== "search" || (platform === 'android' && (query !== name || searchCategory !== category))) navigationHistory.push(navigationSnapshot());
  page = "search";
  query = name;
  searchCategory = category;
  $("#search").value = name;
  window.scrollTo({ top: 0 });
  loadCatalog();
}

function showDownloadStatus() {
  const title = activeDownload ? tr('Downloading {song}', { song: activeDownload.title }) : downloadQueue.length ? tr("Preparing downloads") : tr("Downloads");
  openDialog(`${dialogTop(title)}<p class="dialog-description">${h(tr('{done} / {total} downloads processed. Completed files are available offline.', { done: downloadsDone, total: downloadsTotal }))}</p>${downloadsTotal ? `<progress class="import-progress" value="${downloadsDone}" max="${Math.max(1, downloadsTotal)}"></progress>` : ''}${activeDownload ? `<p class="download-current">${h(tr("The current song is downloading…"))}</p>` : ''}<div class="dialog-buttons"><button class="secondary-btn" data-action="open-downloads">${h(tr("Show saved songs"))}</button>${downloadQueue.length ? `<button class="secondary-btn" data-action="stop-downloads">${h(tr("Stop after current song"))}</button>` : ''}${downloadErrors.length && !activeDownload ? `<button class="secondary-btn" data-action="retry-downloads">${h(tr("Retry failed songs"))}</button>` : ''}</div>${downloadErrors.length ? `<div class="import-errors"><h3>${h(tr("Couldn’t download"))}</h3>${downloadErrors.slice(0, 15).map(item => `<p><strong>${h(item.track.title)}</strong><br>${h(tr(item.error))}</p>`).join('')}</div>` : ''}`, 'downloads');
}

async function queueDownloads(list) {
  if (!deviceStorage || !storageReady) { toast(tr("Downloads are available in the installed app.")); return; }
  if (!downloadRunning && !downloadQueue.length) { downloadsDone = downloadsTotal = 0; downloadErrors = []; }
  const seen = new Set([...downloadQueue.map(track => track.id), activeDownload?.id]);
  let added = 0;
  for (const track of list) {
    if (!canDownload(track) || library.downloads[track.id]?.nativePath || seen.has(track.id)) continue;
    seen.add(track.id);
    remember(track);
    library.downloads[track.id] = { pending: true };
    downloadQueue.push(track);
    downloadsTotal++; added++;
  }
  if (!added) { toast(list.some(track => track.source === 'unmatched') ? tr("Choose recordings for the unmatched songs first. Other songs are already saved or queued.") : tr("These songs are already saved on this device or queued.")); return; }
  downloadErrors.push(...list.filter(track => track.source === 'unmatched').map(track => ({ track, error: 'Choose a recording for this song, then tap Download all again.' })));
  await saveLibrary();
  showDownloadStatus();
  render();
  processDownloads();
}

async function processDownloads() {
  if (downloadRunning) return;
  downloadRunning = true;
  while (downloadQueue.length) {
    const track = activeDownload = downloadQueue.shift();
    if (dialog.open && dialog.dataset.kind === 'downloads') showDownloadStatus();
    try {
      const file = await native.invoke('download_track', { id: track.remoteId, source: track.source });
      library.downloads[track.id] = { ...file, downloadedAt: Date.now() };
      remember(track);
    } catch (error) {
      delete library.downloads[track.id];
      downloadErrors.push({ track, error: String(error.message || error) });
    }
    downloadsDone++;
    await saveLibrary().catch(() => {});
    render();
  }
  activeDownload = null;
  downloadRunning = false;
  if (dialog.open && dialog.dataset.kind === 'downloads') showDownloadStatus();
  toast(downloadErrors.length ? tr('Downloads finished. Retry {count}.', { count: countLabel(downloadErrors.length) }) : tr("Downloads ready. These songs now play from your device."));
}

function showAudioOutput() {
  if (!linuxPlayback) { openDialog(`${dialogTop(tr("Sound output"))}<p class="dialog-description">${h(tr("Undertone uses the sound output selected on this device."))}</p>`, 'audio'); return; }
  const output = audio.outputVolume == null ? tr("Play a song to check the output.") : audio.outputMuted || audio.outputVolume === 0 ? tr("Undertone is muted in the system mixer.") : tr('System mixer: {volume}% · Not muted', { volume: Math.round(audio.outputVolume) });
  openDialog(`${dialogTop(tr("Sound output"))}<div class="sound-summary"><p><strong>${h(tr("System default output"))}</strong><br>${h(tr("Undertone follows your computer’s selected output."))}</p><p>${h(output)}</p><p>${h(tr("Player volume:"))} ${Math.round(audio.volume * 100)}%</p></div><button class="primary-btn" data-action="restore-output" ${!current ? 'disabled' : ''}>${h(tr("Restore Undertone sound"))}</button><p class="dialog-description">${h(tr("This restores this app’s sound without changing the system’s master volume or other apps."))}</p>`, 'audio');
}

function spotifyImportDialog() {
  if (!spotifyState) spotifyState = { collections: [], phase: 'ready', checked: 0, total: 0, note: '', paused: false, resolved: new Map() };
  const state = spotifyState;
  const busy = ['reading', 'matching'].includes(state.phase);
  const unmatched = Object.values(library.tracks).filter(track => track.source === 'unmatched' && track.importRecord);
  const selected = state.collections.filter(item => item.selected !== false);
  openDialog(`${dialogTop(tr("Import from Spotify"))}<p class="dialog-description">${h(tr("Bring your playlists and Liked Songs into Undertone. Songs are matched to the Undertone catalog; anything unmatched stays visible for review."))}</p><div class="spotify-import-tools"><button class="primary-btn" data-action="spotify-files" ${busy ? 'disabled' : ''}>${h(tr("Choose export files"))}</button><button class="secondary-btn" data-action="spotify-help">${h(tr("Get Spotify account data"))}</button></div><p class="import-help">${h(tr("Choose a Spotify account-data ZIP, Playlist / YourLibrary JSON files, or a playlist CSV. YourLibrary imports into Liked Songs. Files are read on this computer."))}</p><details class="spotify-link"><summary>${h(tr("Import a public playlist link"))}</summary><form id="spotify-link-form"><input id="spotify-url" type="text" placeholder="https://open.spotify.com/playlist/…" aria-label="${h(tr("Spotify playlist link"))}" required><button class="secondary-btn" ${busy ? 'disabled' : ''}>${h(tr("Read link"))}</button></form><p class="import-help">${h(tr("Spotify may expose only a preview. Use an export file for a complete playlist or Liked Songs."))}</p></details>${state.note ? `<p class="import-note">${h(state.note)}</p>` : ''}${state.collections.length ? `<div class="spotify-collections">${state.collections.map((item, index) => `<label class="spotify-collection"><input type="checkbox" data-spotify-selected="${index}" ${item.selected !== false ? 'checked' : ''} ${busy ? 'disabled' : ''}><span><strong>${h(item.name)}</strong><small>${countLabel(item.tracks.length)}${item.ignored ? ` · ${h(tr('{count} other entries skipped', { count: item.ignored }))}` : ''}${item.partial ? ' · Public preview only' : ''}</small></span><select data-spotify-kind="${index}" aria-label="Import ${h(item.name)} as" ${busy ? 'disabled' : ''}><option value="playlist" ${item.kind === 'playlist' ? 'selected' : ''}>${h(tr("New playlist"))}</option><option value="liked" ${item.kind === 'liked' ? 'selected' : ''}>${h(tr("Liked Songs"))}</option></select></label>`).join('')}</div>` : ''}${state.phase === 'matching' || state.checked ? `<p class="import-status">${h(tr('{done} / {total} recordings checked', { done: state.checked, total: state.total }))}</p><progress class="import-progress" value="${state.checked}" max="${Math.max(1, state.total)}"></progress>` : ''}<div class="dialog-buttons">${state.collections.length && !['matching', 'done'].includes(state.phase) ? `<button class="primary-btn" data-action="spotify-start" ${!selected.length || busy ? 'disabled' : ''}>${h(tr("Import selected collections"))}</button>` : ''}${state.phase === 'matching' ? `<button class="secondary-btn" data-action="spotify-pause">${h(tr("Pause matching"))}</button>` : unmatched.length ? `<button class="secondary-btn" data-action="spotify-retry">${h(tr("Match"))} ${unmatched.length} remaining songs</button>` : ''}${state.phase === 'done' ? `<button class="secondary-btn" data-action="open-imported-library">${h(tr("Open your library"))}</button>` : ''}</div>${unmatched.length && state.phase !== 'matching' ? `<div class="import-errors"><h3>${h(tr('Recordings to review ({count})', { count: unmatched.length }))}</h3><p>${h(tr("These entries are preserved in their playlists and Liked Songs."))}</p>${unmatched.slice(0, 12).map(track => `<button class="unmatched-import" data-action="find-spotify-match" data-id="${h(track.id)}"><strong>${h(track.title)}</strong><span>${h(track.artist)} · Choose recording</span></button>`).join('')}</div>` : ''}`, 'spotify');
}

async function readSpotifyFiles(files) {
  if (!deviceStorage) { toast(tr("Spotify export import is available in the installed app.")); return; }
  spotifyState = { collections: [], phase: 'reading', checked: 0, total: 0, note: 'Reading your export files…', paused: false, resolved: new Map() };
  spotifyImportDialog();
  try {
    for (const file of files) {
      if (file.size > 32 * 1024 * 1024) throw new Error(tr("Choose files smaller than 32 MB, or select individual playlist exports."));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await native.invoke('parse_spotify', bytes, { headers: { 'x-import-name': encodeURIComponent(file.name) } });
      spotifyState.collections.push(...parsed.collections.map(item => ({ ...item, selected: true })));
    }
    spotifyState.note = tr("Choose the collections to import. This adds to your library and preserves existing playlists.");
  } catch (error) { spotifyState.note = String(error.message || error); }
  spotifyState.phase = 'ready';
  spotifyImportDialog();
}

async function readSpotifyLink(value) {
  if (!spotifyState) spotifyImportDialog();
  spotifyState.phase = 'reading';
  spotifyState.note = tr("Reading public playlist metadata…");
  spotifyImportDialog();
  try {
    const data = await musicRequest('spotify_url', { url: value });
    spotifyState.collections.push(...data.collections.map(item => ({ ...item, selected: true })));
    spotifyState.note = tr("Public links can contain only a preview. The listed count is what will be imported; use an export file for the complete collection.");
  } catch (error) { spotifyState.note = String(error.message || error); }
  spotifyState.phase = 'ready';
  spotifyImportDialog();
}

async function startSpotifyImport() {
  if (!storageReady || !spotifyState || ['matching', 'reading'].includes(spotifyState.phase)) return;
  const selected = spotifyState.collections.filter(item => item.selected !== false);
  if (!selected.length) return;
  spotifyState.phase = 'reading';
  spotifyState.note = tr("Preparing your library…");
  spotifyImportDialog();
  const knownUris = new Map();
  for (const track of Object.values(library.tracks)) if (track.source !== "unmatched") for (const uri of track.spotifyUris || []) knownUris.set(uri, track);
  for (const item of selected) {
    const ids = [];
    for (const record of item.tracks) {
      const placeholder = await spotifyPlaceholder(record);
      const known = record.uri ? knownUris.get(record.uri) : null;
      if (known) ids.push(known.id);
      else { remember(placeholder); ids.push(placeholder.id); }
    }
    if (item.kind === 'liked') library.liked = [...new Set([...library.liked, ...ids])];
    else library.playlists.unshift({ id: crypto.randomUUID(), name: item.name, trackIds: ids, importedFrom: 'Spotify', importedAt: Date.now() });
  }
  await saveLibrary();
  render();
  await matchSpotifyRemaining();
}

function useSpotifyRecording(oldId, candidate) {
  if (!library.tracks[oldId]?.importRecord) return;
  const track = replaceLibraryTrack(library, oldId, candidate);
  tracks.delete(oldId);
  tracks.set(track.id, track);
  for (const row of document.querySelectorAll('.track-row[data-track-id]')) {
    if (row.dataset.trackId !== oldId) continue;
    const number = row.querySelector('.track-number span')?.textContent;
    const holder = document.createElement('div');
    holder.innerHTML = trackRows([track]);
    const replacement = holder.querySelector('.track-row');
    replacement.dataset.trackPosition = row.dataset.trackPosition;
    if (row.dataset.playlistIndex !== undefined) replacement.dataset.playlistIndex = row.dataset.playlistIndex;
    if (number) replacement.querySelector('.track-number span').textContent = number;
    row.replaceWith(replacement);
  }
  spotifyState?.resolved.set(oldId, track.id);
  return track;
}

async function matchSpotifyRemaining() {
  if (!spotifyState) spotifyImportDialog();
  if (spotifyState.phase === 'matching') return;
  const pending = Object.values(library.tracks).filter(track => track.source === 'unmatched' && track.importRecord);
  spotifyState.phase = 'matching';
  spotifyState.paused = false;
  spotifyState.checked = 0;
  spotifyState.total = pending.length;
  spotifyState.note = tr("Your collections are saved. Matching recordings now; you can close this window and keep listening.");
  spotifyImportDialog();
  try {
    for (let index = 0; index < pending.length; index += 4) {
      if (spotifyState.paused) break;
      const batch = pending.slice(index, index + 4);
      const result = await musicRequest('match', { tracks: batch.map(track => track.importRecord) });
      for (let offset = 0; offset < batch.length; offset++) {
        const original = batch[offset];
        const match = result.matches[offset];
        if (match?.track) useSpotifyRecording(original.id, match.track);
        else if (library.tracks[original.id]) library.tracks[original.id].matchReason = match?.reason || tr("No clear match yet.");
      }
      spotifyState.checked += batch.length;
      // ponytail: checkpoint the JSON library every 128 matches; use incremental storage if large imports become frequent.
      if (spotifyState.checked % 128 === 0) await saveLibrary();
      if (dialog.open && dialog.dataset.kind === 'spotify') spotifyImportDialog();
      if (result.matches.length && result.matches.every(match => match.error)) {
        spotifyState.paused = true;
        spotifyState.note = tr("Matching paused because the catalog could not be reached. Your collections are saved; retry the remaining songs later.");
        break;
      }
    }
  } catch (error) {
    spotifyState.paused = true;
    spotifyState.note = tr('Your collections are saved. Matching paused: {error}', { error: tr(String(error.message || error)) });
  }
  await saveLibrary();
  spotifyState.phase = 'done';
  if (!spotifyState.paused) spotifyState.note = tr("Import finished. Matched recordings are playable; remaining entries are kept for review.");
  else if (spotifyState.note === tr('Pausing after the current recordings…')) spotifyState.note = tr("Matching paused. The remaining entries are saved and can be matched later.");
  render();
  if (dialog.open && dialog.dataset.kind === 'spotify') spotifyImportDialog();
  toast(spotifyState.paused ? tr("Spotify collections saved. Matching can continue later.") : tr("Spotify import finished. Unmatched entries are kept for review."));
}

async function findSpotifyMatch(id) {
  const track = getTrack(id);
  if (!track?.importRecord) return;
  openDialog(`${dialogTop(tr("Choose a recording"))}<p class="dialog-description">${h(track.title)} · ${h(track.artist)}</p><p>${h(tr("Finding candidates…"))}</p>`, 'spotify-match');
  dialog.dataset.placeholder = id;
  try {
    const result = await musicRequest('match', { tracks: [track.importRecord] });
    const candidates = result.matches[0]?.candidates || [];
    registerCatalog({ tracks: candidates });
    if (!dialog.open || dialog.dataset.kind !== 'spotify-match' || dialog.dataset.placeholder !== id) return;
    openDialog(`${dialogTop(tr("Choose a recording"))}<p class="dialog-description">${h(track.title)} · ${h(track.artist)}<br>${h(tr("The selected recording will replace this entry in your playlists and Liked Songs."))}</p><div class="match-candidates">${candidates.length ? candidates.map(candidate => `<button class="match-candidate" data-action="choose-spotify-match" data-old-id="${h(id)}" data-id="${h(candidate.id)}"><span class="thumb art-placeholder">${art(candidate)}</span><span><strong>${h(candidate.title)}</strong><small>${h(candidate.artist)} · ${h(candidate.album?.title || '')}</small></span><span>${formatTime(candidate.duration)}</span></button>`).join('') : `<p>${h(result.matches[0]?.reason || tr("No recordings were found. Your entry remains saved; try again later."))}</p>`}</div>`, 'spotify-match');
    dialog.dataset.placeholder = id;
  } catch (error) {
    if (dialog.dataset.kind === 'spotify-match') openDialog(`${dialogTop(tr("Couldn’t find this recording"))}<p class="dialog-description">${h(tr(String(error.message || error)))}</p>`, 'spotify-match');
  }
}

const link = deviceLink({ native, android: !!nativeAudio, platform, openDialog, dialogTop, dialog, toast, prepare: saveLibrary, copied: async result => {
  library = mergePCLibrary(library, result.library, result.deviceId);
  Object.values(library.tracks).forEach(track => tracks.set(track.id, track));
  library.followedArtists.forEach(a => artists.set(a.id, a));
  await saveLibrary();
  render();
} });

const actions = {
  ...link.actions,
  appearance: appearanceDialog,
  language: languageDialog,
  'set-language': button => changeLanguage(button.dataset.lang),
  'search-youtube': async () => { const ticket = requestId; toast(tr("Checking YouTube for more recordings…")); const result = await musicRequest('fallback', { query, artists: searchData.artists }); if (ticket !== requestId) return; registerCatalog(result); searchData.tracks = rankTracks([...searchData.tracks, ...result.tracks], query); searchData.notice = result.tracks.length ? "YouTube song results added. Each row shows its source." : "No additional YouTube recordings were available."; render(); },
  back: goBack,
  "focus-search": () => page === "search" ? $("#search").focus() : navigate("search"),
  "search-name": button => searchName(button.dataset.name),
  "search-filter": button => {
    if (platform === 'android' && searchCategory !== button.dataset.filter) navigationHistory.push(navigationSnapshot());
    searchCategory = button.dataset.filter;
    if (searchCategory !== "videos" && !searchData.musicLoaded) { loadCatalog(); return; }
    render();
    if (searchCategory === "videos" && !searchData.fallbackLoaded && !videoLoading) loadMoreVideos();
  },
  "more-videos": () => loadMoreVideos(requestId, true),
  "open-artist": button => navigate(`artist:${button.dataset.id}`),
  "open-album": button => navigate(`album:${button.dataset.id}`),
  "open-discography": button => navigate(`discography:${button.dataset.id}`),
  "play-release": button => playRelease(button.dataset.id),
  "more-artist-songs": () => { artistSongLimit += 10; render(); },
  "artist-release-filter": button => {
    if (platform === 'android' && artistReleaseTab !== button.dataset.filter) navigationHistory.push(navigationSnapshot());
    artistReleaseTab = button.dataset.filter;
    render();
  },
  "release-view": button => { releaseView = button.dataset.mode; render(); },
  "more-releases": () => { releaseLimit += 8; render(); },
  "retry-release": async button => { await ensureAlbum(button.dataset.id, true); render(); },
  "follow-artist": button => followArtist(button.dataset.id),
  "artist-about": () => { const a = currentArtist(); if (a) openDialog(`${dialogTop(a.name)}<p class="dialog-description artist-biography">${h(a.description || tr("No biography is available for this artist."))}</p><p class="about-version">${h(tr("Artist information from Monochrome"))}</p>`); },
  "artist-radio": () => startRadio(currentArtist()?.tracks?.[0]),
  "artist-videos": () => { const a = currentArtist(); if (a) searchName(`${a.name} official music video`, "videos"); },
  "track-radio": () => { const t = getTrack(pendingTrack); closeDialog(); return startRadio(t); },
  "current-artist": () => { const a = current?.artists?.find(a => a.id); if (a) navigate(`artist:${a.id}`); },
  "menu-artist": () => { const a = getTrack(pendingTrack)?.artists?.find(a => a.id); closeDialog(); if (a) navigate(`artist:${a.id}`); },
  "menu-album": () => { const a = getTrack(pendingTrack)?.album; closeDialog(); if (a?.id) navigate(`album:${a.id}`); },
  "download-track": button => { const track = getTrack(button.dataset.id || pendingTrack); closeDialog(); return queueDownloads([track]); },
  "download-collection": () => queueDownloads(collectionTracks()),
  "download-release": async button => queueDownloads((await ensureAlbum(button.dataset.id || pageId())).tracks),
  "download-status": () => showDownloadStatus(),
  "retry-downloads": () => { const tracks = downloadErrors.map(item => item.track); downloadErrors = []; return queueDownloads(tracks); },
  "stop-downloads": async () => { for (const track of downloadQueue) if (library.downloads[track.id]?.pending) delete library.downloads[track.id]; downloadsTotal -= downloadQueue.length; downloadQueue.length = 0; await saveLibrary(); showDownloadStatus(); },
  "open-downloads": () => { closeDialog(); navigate("downloads"); },
  "remove-download": async button => { const track = getTrack(button.dataset.id || pendingTrack); if (!track) return; await native.invoke("remove_download", { id: track.remoteId, source: track.source }); delete library.downloads[track.id]; await saveLibrary(); closeDialog(); render(); toast(tr("Downloaded copy removed. The song stays in your library.")); },
  "audio-output": () => showAudioOutput(),
  "spotify-import": () => spotifyImportDialog(),
  "spotify-files": () => $("#spotify-file-input").click(),
  "spotify-help": () => native.invoke("spotify_help"),
  "spotify-start": () => startSpotifyImport(),
  "spotify-retry": () => matchSpotifyRemaining(),
  "spotify-pause": () => { if (spotifyState) { spotifyState.paused = true; spotifyState.note = tr("Pausing after the current recordings…"); spotifyImportDialog(); } },
  "find-spotify-match": button => findSpotifyMatch(button.dataset.id),
  "choose-spotify-match": async button => { const track = getTrack(button.dataset.id); if (!track) return; useSpotifyRecording(button.dataset.oldId, track); await saveLibrary(); closeDialog(); render(); toast(tr("Recording selected. Your playlist order is preserved.")); },
  "open-imported-library": () => { closeDialog(); navigate("library"); },
  "restore-output": async () => { await audio.restoreOutput(); $("#volume").value = Math.round(audio.volume * 100); library.volume = audio.volume; await saveLibrary(); updateVolume(); showAudioOutput(); },
  "release-queue": async button => enqueueTracks((await ensureAlbum(button.dataset.id)).tracks),
  "autoplay": () => { autoplay = !autoplay; renderQueue(); },
  discover: () => navigate("discover"),
  import: () => $("#file-input").click(),
  about,
  retry: () => loadCatalog(true),
  refresh: () => loadCatalog(true),
  play: (button) => { const track = getTrack(button.dataset.id); if (!track) return; if (track.source === "unmatched") return findSpotifyMatch(track.id); const list = playbackContext(button); const rowIndex = Number(button.closest(".track-row")?.dataset.trackPosition); const index = Number.isInteger(rowIndex) && list[rowIndex]?.id === track.id ? rowIndex : list.findIndex(item => item.id === track.id); return playAt(index < 0 ? 0 : index, index < 0 ? [track] : list, false, playlist()?.id || null); },
  "play-all": () => playAt(0, collectionTracks(), false, playlist()?.id || null),
  "shuffle-all": () => { shuffle = true; updateModes(); const list = collectionTracks(); playAt(Math.floor(Math.random() * list.length), list, false, playlist()?.id || null); },
  "play-discovery": () => { if (remoteTracks.length && remoteStatus === "ready") playAt(0, remoteTracks); else toast(remoteStatus === "loading" ? tr("Finding some music for you…") : tr("Try refreshing discovery, or import your own music.")); },
  "play-pause": togglePlayback,
  previous: () => step(-1),
  next: () => step(1),
  shuffle: () => {
    shuffle = !shuffle;
    shuffleOrder = shuffle && !nativeAudio ? shuffleQueueKeys(queue, current?.queueKey) : [];
    updateModes();
    if (nativeAudio) nativeAudio.command("shuffle", String(shuffle)); else primeNextTrack();
  },
  repeat: () => { repeat = { off: "all", all: "one", one: "off" }[repeat]; updateModes(); if (nativeAudio) nativeAudio.command("repeat", repeat); else primeNextTrack(); },
  mute: () => { audio.muted = !audio.muted; updateVolume(); if (nativeAudio) nativeAudio.command("volume", String(audio.muted ? 0 : audio.volume)); },
  queue: () => { const open = $("#queue-panel").classList.toggle("hidden") === false; $("#queue-toggle").classList.toggle("on", open); $("#queue-toggle").setAttribute("aria-expanded", open); renderQueue(); },
  "queue-play": (button) => playAt(Number(button.dataset.index)),
  expand: () => { if (window.innerWidth <= 650) document.body.classList.toggle("player-expanded"); else actions.queue(); },
  like: (button) => likeTrack(button.dataset.id),
  "like-current": () => current && likeTrack(current.id, current),
  "track-menu": (button) => trackMenu(button.dataset.id, Number(button.closest(".track-row")?.dataset.playlistIndex)),
  "close-dialog": closeDialog,
  "create-playlist": () => { pendingTrack = null; playlistDialog(); },
  "rename-playlist": () => playlistDialog(true),
  "create-for-track": () => playlistDialog(),
  "add-playlist-track": (button) => addTrackToPlaylist(button.dataset.id, pendingTrack),
  "menu-like": () => { const id = pendingTrack; closeDialog(); return likeTrack(id); },
  "add-queue": () => { const track = getTrack(pendingTrack); if (!track) return; if (track.source === 'unmatched') return findSpotifyMatch(track.id); closeDialog(); enqueueTracks([track]); },
  "pin-playlist": button => pinPlaylist(button.dataset.id),
  "queue-add-track": button => { const track = getTrack(button.dataset.id); if (track?.source === 'unmatched') return findSpotifyMatch(track.id); if (track) enqueueTracks([track]); },
  "queue-add": () => { queueAddMode = true; $('#queue-panel').classList.add('hidden'); $('#queue-toggle').setAttribute('aria-expanded', 'false'); $('#queue-toggle').classList.remove('on'); navigate('search'); $('#search').focus(); },
  "queue-add-done": () => { queueAddMode = false; render(); $('#queue-panel').classList.remove('hidden'); $('#queue-toggle').setAttribute('aria-expanded', 'true'); $('#queue-toggle').classList.add('on'); renderQueue(); },
  "queue-move": button => { const from = Number(button.dataset.index); reorderQueue(from, from + Number(button.dataset.direction)); },
  "queue-remove": button => { const index = Number(button.dataset.index); if (index === queueIndex || !queue[index]) return; queue.splice(index, 1); if (index < queueIndex) queueIndex--; syncQueue(); },
  "remove-playlist-track": async button => {
    const p = playlist();
    if (button.disabled || !p || !removePlaylistEntry(p.trackIds, Number(button.dataset.index), pendingTrack)) return;
    button.disabled = true;
    closeDialog(); render();
    await saveLibrary();
    toast(tr("Removed from playlist"));
  },
  "remove-local": () => { openDialog(`${dialogTop(tr("Remove this imported copy?"))}<p class="dialog-description">${h(tr("This removes the song from this app, including liked songs and playlists. Your original file stays untouched."))}</p><div class="dialog-buttons"><button class="secondary-btn" data-action="close-dialog">${h(tr("Keep it"))}</button><button class="danger-btn" data-action="confirm-remove-local">${h(tr("Remove copy"))}</button></div>`); },
  "confirm-remove-local": () => removeLocal(pendingTrack),
  "delete-playlist": () => { openDialog(`${dialogTop(tr("Delete this playlist?"))}<p class="dialog-description">${h(playlist()?.name)} will be removed. Your music files and liked songs stay in your library.</p><div class="dialog-buttons"><button class="secondary-btn" data-action="close-dialog">${h(tr("Keep it"))}</button><button class="danger-btn" data-action="confirm-delete-playlist">${h(tr("Delete playlist"))}</button></div>`); },
  "confirm-delete-playlist": async () => { const id = playlist()?.id; library.playlists = library.playlists.filter((p) => p.id !== id); await saveLibrary(); closeDialog(); navigate("library"); toast(tr("Playlist deleted")); },
};

if (nativeAudio) {
  document.body.classList.add('android-app');
  swipeToQueue(view, id => { if (getTrack(id)?.source !== 'unmatched') actions['queue-add-track']({ dataset: { id } }); });
}

function updateModes() {
  $("#shuffle").classList.toggle("on", shuffle);
  $("#shuffle").setAttribute("aria-pressed", shuffle);
  $("#shuffle").setAttribute("aria-label", shuffle ? tr("Turn shuffle off") : tr("Turn shuffle on"));
  $("#repeat").classList.toggle("on", repeat !== "off");
  $("#repeat").setAttribute("aria-pressed", repeat !== "off");
  $("#repeat").setAttribute("aria-label", tr(repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat off'));
  $(".repeat-one").classList.toggle("hidden", repeat !== "one");
}

function updateVolume() {
  $("#mute").innerHTML = icon(audio.muted || audio.volume === 0 ? "mute" : "volume");
  $("#mute").setAttribute("aria-label", audio.muted ? tr("Unmute") : tr("Mute"));
  setRange($("#volume"));
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action], [data-view]");
  if (!button || button.disabled) return;
  if (button.dataset.view) { navigate(button.dataset.view); return; }
  try { await actions[button.dataset.action]?.(button); }
  catch (error) { console.error(error); toast(tr("That change couldn’t be completed. Please try again.")); }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === 'link-form') { event.preventDefault(); await link.submit(); return; }
  if (event.target.id === "spotify-link-form") { event.preventDefault(); readSpotifyLink($("#spotify-url").value.trim()); return; }
  if (event.target.id !== "playlist-form") return;
  event.preventDefault();
  if (!storageReady) { toast(tr("Restart the app to reopen your library before making changes.")); return; }
  const name = $("#playlist-name").value.trim();
  if (!name) { $("#playlist-name").focus(); return; }
  const renameId = event.target.dataset.rename;
  const p = renameId ? library.playlists.find((item) => item.id === renameId) : { id: crypto.randomUUID(), name, trackIds: [] };
  if (!p) return;
  p.name = name;
  if (!renameId) {
    if (pendingTrack && getTrack(pendingTrack)) { remember(getTrack(pendingTrack)); p.trackIds.push(pendingTrack); }
    library.playlists.unshift(p);
  }
  try {
    await saveLibrary();
    pendingTrack = null;
    closeDialog();
    navigate(`playlist:${p.id}`);
    toast(renameId ? tr("New name, same good music.") : tr("Playlist created. Make it yours."));
  } catch {}
});

$("#search").addEventListener("input", () => {
  if (page !== "search") navigationHistory.push(navigationSnapshot());
  query = $("#search").value.trim();
  page = "search";
  ++requestId;
  remoteStatus = "loading";
  render();
  clearTimeout(searchTimer);
  if (query) searchTimer = setTimeout(() => loadCatalog(), 450);
});
$("#search-form").addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(searchTimer); if (query) loadCatalog(); });
$("#clear-search").addEventListener("click", () => { clearTimeout(searchTimer); ++requestId; query = ""; $("#search").value = ""; render(); $("#search").focus(); });
$("#file-input").addEventListener("change", (event) => importFiles(event.target.files));
$("#spotify-file-input").addEventListener("change", event => { const files = [...event.target.files]; event.target.value = ""; if (files.length) readSpotifyFiles(files); });
document.addEventListener("change", (event) => {
  let iconChange;
  if (event.target.name === 'theme' && event.target.checked) {
    window.undertoneAppearance.select(event.target.value);
    iconChange = syncIconWithTheme();
  } else if (event.target.name === 'sync-app-icon') {
    iconChange = setIconSync(event.target.checked);
  } else if (event.target.name === 'app-icon' && event.target.checked) {
    iconChange = selectAppIcon(event.target.value);
  }
  if (iconChange) {
    dialog.querySelector('.app-icon-error').textContent = '';
    iconChange.catch(() => {
      const message = tr('Couldn’t change the app icon. Please try again.');
      const notice = dialog.open && dialog.querySelector('.app-icon-error');
      if (notice) notice.textContent = message;
      else toast(message);
    });
  }
  if (event.target.dataset.spotifySelected !== undefined && spotifyState) { const item = spotifyState.collections[Number(event.target.dataset.spotifySelected)]; if (item) item.selected = event.target.checked; }
  if (event.target.dataset.spotifyKind !== undefined && spotifyState) { const item = spotifyState.collections[Number(event.target.dataset.spotifyKind)]; if (item && ["playlist", "liked"].includes(event.target.value)) item.kind = event.target.value; }
  if (event.target.id === "sort") { sort = event.target.value; render(); }
  if (event.target.id === "release-filter") { releaseFilter = event.target.value; releaseLimit = 8; render(); }
  if (event.target.id === "release-sort") { releaseSort = event.target.value; render(); }
});

$("#volume").addEventListener("input", () => {
  audio.volume = Number($("#volume").value) / 100;
  audio.muted = false;
  updateVolume();
  if (nativeAudio) nativeAudio.command("volume", String(audio.volume));
});
$("#volume").addEventListener("change", () => { library.volume = audio.volume; saveLibrary().catch(() => {}); });
$("#seek").addEventListener("input", () => {
  seeking = true;
  setRange($("#seek"));
  const length = nativeAudio ? current?.duration || 0 : audio.duration;
  if (Number.isFinite(length)) $("#elapsed").textContent = formatTime(Number($("#seek").value) / 1000 * length);
});
$("#seek").addEventListener("change", () => {
  seeking = false;
  const length = nativeAudio ? current?.duration || 0 : audio.duration;
  if (!Number.isFinite(length) || !length) return;
  const time = Number($("#seek").value) / 1000 * length;
  if (nativeAudio) nativeAudio.command("seek", String(time));
  else audio.currentTime = time;
});

audio.addEventListener("play", () => { playing = true; updatePlayIcons(); });
audio.addEventListener("pause", () => { playing = false; updatePlayIcons(); });
audio.addEventListener("loadedmetadata", () => { if (current && Number.isFinite(audio.duration)) current.duration = audio.duration; updateProgress(); });
audio.addEventListener("timeupdate", () => { updateProgress(); primeNextTrack(); });
audio.addEventListener("ended", () => step(1, true));
window.addEventListener('offline', clearPreload);
audio.addEventListener('trackchange', event => {
  if (loading) return;
  const index = queue.findIndex(t => t.queueKey === event.key);
  if (index < 0) return;
  ++playTicket;
  nextPreload = null;
  queueIndex = index; current = queue[index];
  recordRecent(current); mediaMetadata(); updatePlayer(); primeNextTrack();
});
audio.addEventListener("error", () => { if (!current || !audio.src) return; clearPreload(); playing = loading = false; updatePlayIcons(); toast(audio.error?.message || (current.source === "local" ? tr("This file couldn’t play. Your device may not support its format.") : tr("This stream is unavailable. Try another song or check your connection.")), 6500); });

document.addEventListener("keydown", (event) => {
  const editing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
  if (event.key === "Escape") { document.body.classList.remove("player-expanded"); $("#queue-panel").classList.add("hidden"); $("#queue-toggle").classList.remove("on"); $("#queue-toggle").setAttribute("aria-expanded", "false"); }
  if (editing || dialog.open || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "/") { event.preventDefault(); navigate("search"); }
  if (event.code === "Space" && !event.target.closest("button")) { event.preventDefault(); togglePlayback(); }
  if (event.key.toLowerCase() === "m") actions.mute();
});

dialog.addEventListener("click", (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
document.addEventListener("error", (event) => {
  if (!event.target.matches?.('img[data-cover]')) return;
  const tile = event.target.closest('.cover-tile');
  if (tile) { tile.textContent = '♪'; return; }
  const cover = event.target.closest('[data-cover-album]');
  if (cover) {
    const id = cover.dataset.coverAlbum;
    const album = albums.get(id);
    if (album) album.artwork = '';
    cover.innerHTML = coverCollage(album);
    ensureAlbum(id).then(full => { full.artwork = ''; if (cover.isConnected) cover.innerHTML = coverCollage(full); }).catch(() => {});
  } else { const parent = event.target.parentElement; parent.innerHTML = icon('music'); parent.classList.add('art-placeholder'); }
}, true);
let dragDepth = 0;
document.addEventListener("dragenter", (event) => { if (isFileDrag(event.dataTransfer)) { event.preventDefault(); dragDepth++; $("#drop-overlay").classList.remove("hidden"); } });
document.addEventListener("dragover", (event) => { if (isFileDrag(event.dataTransfer)) event.preventDefault(); });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").classList.add("hidden"); } });
document.addEventListener("drop", (event) => { event.preventDefault(); dragDepth = 0; $("#drop-overlay").classList.add("hidden"); if (event.dataTransfer?.files.length) importFiles(event.dataTransfer.files); });
$('#queue-content').addEventListener('dragstart', event => {
  const row = event.target.closest('[data-queue-key]');
  if (!row) return;
  draggedQueueKey = row.dataset.queueKey;
  event.dataTransfer.setData('application/x-undertone-queue', draggedQueueKey);
  event.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging');
});
$('#queue-content').addEventListener('dragover', event => {
  const row = event.target.closest('[data-queue-key]');
  if (!row || !draggedQueueKey) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
  row.classList.add('drop-target');
});
$('#queue-content').addEventListener('drop', event => {
  const row = event.target.closest('[data-queue-key]');
  if (!row || !draggedQueueKey) return;
  event.preventDefault(); event.stopPropagation();
  const from = queue.findIndex(t => t.queueKey === draggedQueueKey);
  const to = queue.findIndex(t => t.queueKey === row.dataset.queueKey);
  draggedQueueKey = ''; reorderQueue(from, to);
});
document.addEventListener('dragend', () => { draggedQueueKey = ''; document.querySelectorAll('.dragging,.drop-target').forEach(node => node.classList.remove('dragging', 'drop-target')); });
document.querySelector(".brand").addEventListener("click", (event) => { event.preventDefault(); navigate("discover"); });

if ("mediaSession" in navigator && !nativeAudio) {
  const handlers = { play: () => { if (audio.paused) togglePlayback(); }, pause: () => audio.pause(), previoustrack: () => step(-1), nexttrack: () => step(1), seekto: (details) => { if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime; } };
  for (const [action, handler] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} }
}

if (nativeAudio) {
  setInterval(() => {
    try {
      const state = JSON.parse(nativeAudio.state());
      if (state.session && state.session !== queueSession) return;
      if (state.error && state.error !== lastNativeError) { lastNativeError = state.error; toast(state.error, 6500); }
      if (!state.error) lastNativeError = "";
      const index = state.key && queue[state.index]?.queueKey !== state.key
        ? queue.findIndex(t => t.queueKey === state.key)
        : state.index;
      if (index >= 0 && queue[index] && (queueIndex !== index || current?.queueKey !== queue[index].queueKey)) {
        queueIndex = index;
        current = queue[queueIndex];
        updatePlayer();
      }
      if (playing !== !!state.playing || loading !== !!state.loading) { playing = !!state.playing; loading = !!state.loading; updatePlayIcons(); }
      const signature = `${state.session}:${state.serial}:${state.key || index}`;
      if (state.playing && current && signature !== lastNativeTrack) { lastNativeTrack = signature; recordRecent(current, state.playedAt || undefined); }
      else if (state.playing && current && state.playedAt && markPlaylistPlayed(current.playlistId, state.playedAt)) saveLibrary().catch(() => {});
      if (typeof state.shuffle === "boolean" && (shuffle !== state.shuffle || repeat !== state.repeat)) { shuffle = state.shuffle; repeat = state.repeat; updateModes(); }
      if (state.duration > 0 && current) current.duration = state.duration;
      updateProgress(state.position || 0, state.duration || current?.duration || 0);
    } catch (error) { console.error(error); }
  }, 250);
}

try { await loadLibrary(); }
catch (error) { console.error(error); toast(tr("Your saved library could not be opened. It has been left untouched. Restart the app before saving changes."), 10000); }
if (nativeAudio) {
  try {
    const restored = JSON.parse(nativeAudio.queue());
    if (Array.isArray(restored.tracks) && restored.tracks.length) {
      queue = queueEntries(restored.tracks);
      queueSession = restored.session || '';
      queue.forEach((track) => tracks.set(track.id, track));
      queueIndex = restored.index;
      current = queue[queueIndex] || null;
      updatePlayer();
    }
  } catch (error) { console.error(error); }
}
translateStatic(document);
updateModes();
updateVolume();
render();
loadCatalog();
