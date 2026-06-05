const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const router = express.Router();

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const SOUNDCLOUD_CLIENT_SECRET = process.env.SOUNDCLOUD_CLIENT_SECRET;
const SOUNDCLOUD_REDIRECT_URI = process.env.SOUNDCLOUD_REDIRECT_URI;
const SOUNDCLOUD_WIDGET_CLIENT_ID = 'gqKBMSuBw5rbN9rDRYPqKNvF17ovlObu';
const SOUNDCLOUD_PUBLIC_CLIENT_IDS = Array.from(new Set([
  process.env.SOUNDCLOUD_PUBLIC_CLIENT_ID,
  SOUNDCLOUD_WIDGET_CLIENT_ID,
  process.env.SOUNDCLOUD_CLIENT_ID,
].filter(Boolean)));
const SOUNDCLOUD_APP_VERSION = process.env.SOUNDCLOUD_APP_VERSION || '1778162840';
const SOUNDCLOUD_STREAM_CACHE_TTL_MS = 4 * 60 * 1000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';

const SOUNDCLOUD_AUTH_COOKIE = 'soundcloud_oauth_state';
const soundCloudStreamCache = new Map();
const SPOTIFY_SCOPE = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

function ensureConfig(res, provider, values) {
  if (values.every(Boolean)) return true;

  res.status(500).json({
    message: `${provider} OAuth is not configured on the server`,
  });
  return false;
}

function getOAuthCookieOptions(maxAgeMs) {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    maxAge: maxAgeMs,
    path: '/',
  };
}

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());

  return { verifier, challenge };
}

function encodeOAuthState(state) {
  return base64Url(Buffer.from(JSON.stringify(state), 'utf8'));
}

function decodeOAuthState(rawState) {
  if (!rawState) return null;

  try {
    return JSON.parse(fromBase64Url(rawState).toString('utf8'));
  } catch (error) {
    return null;
  }
}

function createBasicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function redirectToFrontend(res, params) {
  const target = new URL(FRONTEND_URL);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      target.searchParams.set(key, value);
    }
  });

  res.redirect(target.toString());
}

function normalizeSoundCloudUrl(value) {
  const trimmedValue = String(value || '').trim();
  const absoluteValue = /^(www\.)?soundcloud\.com\//i.test(trimmedValue)
    ? `https://${trimmedValue}`
    : trimmedValue;

  try {
    const url = new URL(absoluteValue);
    if (!/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
      return null;
    }

    url.protocol = 'https:';
    const secretToken = url.searchParams.get('secret_token');
    url.hash = '';
    url.search = '';
    if (secretToken) {
      url.searchParams.set('secret_token', secretToken);
    }
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    return null;
  }
}

function normalizeSoundCloudImage(value) {
  if (!value) return null;

  return String(value)
    .replace(/^http:/i, 'https:')
    .replace('-large.', '-t500x500.')
    .replace('-t300x300.', '-t500x500.')
    .replace('-t200x200.', '-t500x500.');
}

function getFirstPlaylistTrackImage(playlist) {
  if (!Array.isArray(playlist?.tracks)) return null;

  const track = playlist.tracks.find(candidate =>
    candidate?.artwork_url
    || candidate?.image
    || candidate?.album?.images?.[0]?.url
    || candidate?.user?.avatar_url
  );

  return track?.artwork_url
    || track?.image
    || track?.album?.images?.[0]?.url
    || track?.user?.avatar_url
    || null;
}

function normalizeSoundCloudPlaylist(playlist) {
  const uri = normalizeSoundCloudUrl(playlist?.permalink_url || playlist?.url);
  if (!uri) return null;

  const owner = playlist?.user?.username || playlist?.owner || playlist?.publisher || '';
  const ownerId = playlist?.user?.id ?? playlist?.user_id ?? playlist?.ownerId;
  const image = normalizeSoundCloudImage(
    playlist?.artwork_url
    || playlist?.image
    || getFirstPlaylistTrackImage(playlist)
    || playlist?.user?.avatar_url
  ) || 'assets/playlist-placeholder.png';

  return {
    id: String(playlist?.id ?? uri),
    name: playlist?.title || playlist?.name || 'SoundCloud playlist',
    uri,
    type: 'playlist',
    image,
    owner,
    ownerId: ownerId ? String(ownerId) : undefined,
    album: { images: [{ url: image }] },
    artists: owner ? [{ id: ownerId ? String(ownerId) : undefined, name: owner }] : [],
    images: [{ url: image }],
    duration: playlist?.duration,
  };
}

function normalizeSoundCloudTrack(track) {
  const uri = normalizeSoundCloudUrl(track?.permalink_url || track?.url);
  if (!uri) return null;

  const owner = track?.user?.username || track?.artist || track?.publisher || '';
  const ownerId = track?.user?.id ?? track?.user_id ?? track?.ownerId;
  const image = normalizeSoundCloudImage(
    track?.artwork_url
    || track?.image
    || track?.user?.avatar_url
  ) || 'assets/spotify-placeholder.png';

  return {
    id: String(track?.id ?? uri),
    name: track?.title || track?.name || 'SoundCloud track',
    uri,
    type: 'track',
    image,
    artist: owner,
    artistId: ownerId ? String(ownerId) : undefined,
    owner,
    ownerId: ownerId ? String(ownerId) : undefined,
    publisher: owner,
    album: { images: [{ url: image }] },
    artists: owner ? [{ id: ownerId ? String(ownerId) : undefined, name: owner }] : [],
    images: [{ url: image }],
    duration: track?.duration,
  };
}

function asSoundCloudCollection(responseData) {
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData?.collection)) return responseData.collection;
  return [];
}

async function getSoundCloudApi(pathOrUrl, params = {}) {
  let lastError;

  for (const clientId of SOUNDCLOUD_PUBLIC_CLIENT_IDS) {
    const endpoint = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(`https://api-v2.soundcloud.com/${String(pathOrUrl).replace(/^\//, '')}`);

    endpoint.protocol = 'https:';
    Object.entries(params).forEach(([key, value]) => endpoint.searchParams.set(key, value));
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('client_id', clientId);
    endpoint.searchParams.set('app_version', SOUNDCLOUD_APP_VERSION);

    try {
      const response = await axios.get(endpoint.toString(), {
        headers: { accept: 'application/json' },
      });

      return response.data;
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error.response?.status)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function getSoundCloudPaginatedCollection(pathOrUrl, params = {}) {
  const collection = [];
  let nextUrl = pathOrUrl;
  let nextParams = params;
  let pageCount = 0;

  while (nextUrl && pageCount < 20) {
    const data = await getSoundCloudApi(nextUrl, nextParams);
    collection.push(...asSoundCloudCollection(data));
    nextUrl = typeof data?.next_href === 'string' ? data.next_href : null;
    nextParams = {};
    pageCount += 1;
  }

  return collection;
}

function getPlayableSoundCloudTrack(resource) {
  if (!resource) return null;
  if (resource.kind === 'track' && Array.isArray(resource.media?.transcodings)) {
    return resource;
  }

  return null;
}

function selectSoundCloudTranscoding(track) {
  const transcodings = Array.isArray(track?.media?.transcodings)
    ? track.media.transcodings
    : [];

  return transcodings.find(transcoding =>
    transcoding?.format?.protocol === 'progressive'
    && /mpeg|mp3|audio/i.test(String(transcoding?.format?.mime_type || ''))
  ) || transcodings.find(transcoding => transcoding?.format?.protocol === 'progressive') || null;
}

async function resolveSoundCloudAudioStream(sourceUrl) {
  const normalizedUrl = normalizeSoundCloudUrl(sourceUrl);
  if (!normalizedUrl) {
    throw new Error('Missing or invalid SoundCloud URL');
  }

  const cached = soundCloudStreamCache.get(normalizedUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const resource = await getSoundCloudApi('resolve', { url: normalizedUrl });
  const track = getPlayableSoundCloudTrack(resource);
  if (!track) {
    throw new Error('SoundCloud URL did not resolve to a playable track');
  }

  const transcoding = selectSoundCloudTranscoding(track);
  if (!transcoding?.url) {
    throw new Error('SoundCloud track has no progressive audio transcoding');
  }

  const streamInfo = await getSoundCloudApi(transcoding.url);
  if (!streamInfo?.url) {
    throw new Error('SoundCloud did not return a playable audio URL');
  }

  const value = {
    sourceUrl: normalizedUrl,
    mediaUrl: streamInfo.url,
    mimeType: transcoding.format?.mime_type || 'audio/mpeg',
    track: normalizeSoundCloudTrack(track),
  };
  soundCloudStreamCache.set(normalizedUrl, {
    value,
    expiresAt: Date.now() + SOUNDCLOUD_STREAM_CACHE_TTL_MS,
  });
  return value;
}

function getSoundCloudUserId(user) {
  const id = user?.id ?? user?.user_id;
  if (id) return String(id);

  const match = String(user?.urn || user?.uri || '').match(/soundcloud:users:(\d+)/);
  return match?.[1] || null;
}

router.get('/login', (req, res) => {
  if (!ensureConfig(res, 'Spotify', [SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI])) {
    return;
  }

  res.redirect('https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: SPOTIFY_CLIENT_ID,
      scope: SPOTIFY_SCOPE,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }).toString());
});

router.get('/soundcloud/login', (req, res) => {
  if (!ensureConfig(res, 'SoundCloud', [SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET, SOUNDCLOUD_REDIRECT_URI])) {
    return;
  }

  const state = base64Url(crypto.randomBytes(24));
  const { verifier, challenge } = createPkcePair();

  res.cookie(
    SOUNDCLOUD_AUTH_COOKIE,
    encodeOAuthState({ state, verifier }),
    getOAuthCookieOptions(10 * 60 * 1000)
  );

  res.redirect('https://secure.soundcloud.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: SOUNDCLOUD_CLIENT_ID,
      redirect_uri: SOUNDCLOUD_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString());
});

router.get('/soundcloud/user-playlists', async (req, res) => {
  const profileUrl = normalizeSoundCloudUrl(req.query.url);
  if (!profileUrl) {
    return res.status(400).json({ message: 'Missing or invalid SoundCloud user URL' });
  }

  try {
    const user = await getSoundCloudApi('resolve', { url: profileUrl });
    const userId = getSoundCloudUserId(user);
    if (!userId) {
      return res.status(404).json({ message: 'SoundCloud user not found' });
    }

    const playlists = await getSoundCloudPaginatedCollection(`users/${userId}/playlists`, {
      limit: '50',
      offset: '0',
      linked_partitioning: '1',
    });

    const seenUris = new Set();
    const normalizedPlaylists = playlists
      .map(normalizeSoundCloudPlaylist)
      .filter(Boolean)
      .filter(playlist => {
        if (seenUris.has(playlist.uri)) return false;

        seenUris.add(playlist.uri);
        return true;
      });

    res.json({ playlists: normalizedPlaylists });
  } catch (error) {
    console.error('SoundCloud user playlist import error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: 'Could not fetch SoundCloud user playlists',
    });
  }
});

router.get('/soundcloud/stream-info', async (req, res) => {
  const sourceUrl = normalizeSoundCloudUrl(req.query.url);
  if (!sourceUrl) {
    return res.status(400).json({ message: 'Missing or invalid SoundCloud track URL' });
  }

  try {
    const stream = await resolveSoundCloudAudioStream(sourceUrl);
    res.json({
      sourceUrl: stream.sourceUrl,
      mimeType: stream.mimeType,
      track: stream.track,
    });
  } catch (error) {
    console.error('SoundCloud stream info error:', error.response?.data || error.message);
    res.status(error.response?.status || 502).json({
      message: 'Could not resolve SoundCloud audio for streaming',
      details: error.message,
    });
  }
});

router.get('/soundcloud/audio', async (req, res) => {
  const sourceUrl = normalizeSoundCloudUrl(req.query.url);
  if (!sourceUrl) {
    return res.status(400).json({ message: 'Missing or invalid SoundCloud track URL' });
  }

  try {
    const stream = await resolveSoundCloudAudioStream(sourceUrl);
    const upstream = await axios.get(stream.mediaUrl, {
      responseType: 'stream',
      headers: {
        accept: 'audio/*,*/*',
        ...(req.headers.range ? { range: req.headers.range } : {}),
      },
      validateStatus: status => status === 200 || status === 206,
    });

    res.status(upstream.status);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', upstream.headers['content-type'] || stream.mimeType || 'audio/mpeg');
    ['content-length', 'content-range', 'accept-ranges'].forEach(header => {
      if (upstream.headers[header]) {
        res.setHeader(header, upstream.headers[header]);
      }
    });

    upstream.data.on('error', error => {
      console.error('SoundCloud audio proxy stream error:', error.message);
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
    });
    upstream.data.pipe(res);
  } catch (error) {
    console.error('SoundCloud audio proxy error:', error.response?.data || error.message);
    res.status(error.response?.status || 502).json({
      message: 'Could not stream SoundCloud audio',
      details: error.message,
    });
  }
});

router.get('/callback', async (req, res) => {
  const code = req.query.code || null;

  if (!ensureConfig(res, 'Spotify', [SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI])) {
    return;
  }

  if (!code) {
    return res.status(400).json({ message: 'Missing Spotify authorization code' });
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://accounts.spotify.com/api/token',
      data: new URLSearchParams({
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: createBasicAuthHeader(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
      },
    });

    const { access_token, refresh_token } = response.data;

    redirectToFrontend(res, { access_token, refresh_token });
  } catch (error) {
    console.error('Spotify Callback Error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Error during Spotify callback' });
  }
});

router.get('/soundcloud/callback', async (req, res) => {
  const code = req.query.code || null;
  const returnedState = req.query.state || null;

  if (!ensureConfig(res, 'SoundCloud', [SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET, SOUNDCLOUD_REDIRECT_URI])) {
    return;
  }

  if (!code) {
    return res.status(400).json({ message: 'Missing SoundCloud authorization code' });
  }

  const storedState = decodeOAuthState(req.cookies?.[SOUNDCLOUD_AUTH_COOKIE]);
  res.clearCookie(SOUNDCLOUD_AUTH_COOKIE, getOAuthCookieOptions(0));

  if (!storedState?.state || !storedState?.verifier || storedState.state !== returnedState) {
    return res.status(400).json({ message: 'Invalid SoundCloud OAuth state' });
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://secure.soundcloud.com/oauth/token',
      data: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: SOUNDCLOUD_CLIENT_ID,
        client_secret: SOUNDCLOUD_CLIENT_SECRET,
        redirect_uri: SOUNDCLOUD_REDIRECT_URI,
        code_verifier: storedState.verifier,
        code,
      }).toString(),
      headers: {
        accept: 'application/json; charset=utf-8',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    const { access_token, refresh_token, expires_in, scope } = response.data;

    redirectToFrontend(res, {
      provider: 'soundcloud',
      soundcloud_access_token: access_token,
      soundcloud_refresh_token: refresh_token,
      soundcloud_expires_in: expires_in,
      soundcloud_scope: scope,
    });
  } catch (error) {
    console.error('SoundCloud Callback Error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Error during SoundCloud callback' });
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!ensureConfig(res, 'Spotify', [SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI])) {
    return;
  }

  if (!refresh_token) {
    return res.status(400).json({ message: 'Missing Spotify refresh token' });
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://accounts.spotify.com/api/token',
      data: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
      }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: createBasicAuthHeader(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET),
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Spotify Refresh Error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Error refreshing Spotify token' });
  }
});

router.post('/soundcloud/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!ensureConfig(res, 'SoundCloud', [SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET, SOUNDCLOUD_REDIRECT_URI])) {
    return;
  }

  if (!refresh_token) {
    return res.status(400).json({ message: 'Missing SoundCloud refresh token' });
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://secure.soundcloud.com/oauth/token',
      data: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: SOUNDCLOUD_CLIENT_ID,
        client_secret: SOUNDCLOUD_CLIENT_SECRET,
        refresh_token,
      }).toString(),
      headers: {
        accept: 'application/json; charset=utf-8',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('SoundCloud Refresh Error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Error refreshing SoundCloud token' });
  }
});

module.exports = router;
