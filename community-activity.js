// community-activity.js — Community Pulse helper for MaxParfum
// Queries activity_events and profiles from Supabase.
// All queries are defensive: if the table doesn't exist or the query fails,
// functions return empty arrays / null and log a warning only.

import { supabase } from './supabase.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeDisplayName(profile) {
  if (!profile) return 'A MaxParfum member';
  const username = profile.username || profile.display_name || profile.full_name;
  if (username) return '@' + username.replace(/^@/, '');
  return 'A MaxParfum member';
}

function safeAvatarUrl(profile) {
  return (profile && profile.avatar_url) || null;
}

const ACTIVITY_LABELS = {
  rating:        (a) => `rated ${_fragName(a)} ${_stars(a)}`,
  review:        (a) => `reviewed ${_fragName(a)}`,
  collection_add:(a) => `added ${_fragName(a)} to their collection`,
  battle_pick:   (a) => `picked ${_fragName(a)} in a battle`,
  scentle:       (a) => `completed today's Scentle${_scentleGuesses(a)}`,
  forum_post:    (a) => `joined a discussion`,
  comment:       (a) => `commented on ${_fragName(a)}`,
};

function _fragName(a) {
  if (a.fragrance_brand && a.fragrance_name) {
    return `${a.fragrance_brand} ${a.fragrance_name}`;
  }
  return (a.metadata && a.metadata.fragrance_name) || 'a fragrance';
}

function _stars(a) {
  const v = a.metadata && a.metadata.rating_value;
  if (!v) return '';
  return `${parseFloat(v).toFixed(1)} stars`;
}

function _scentleGuesses(a) {
  const g = a.metadata && a.metadata.guesses;
  if (!g) return '';
  return ` in ${g} ${g === 1 ? 'guess' : 'guesses'}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch recent public activity for the homepage Community Pulse section.
 * @param {number} limit
 * @returns {Promise<Array>} formatted activity items
 */
export async function getCommunityPulse(limit = 12) {
  try {
    const { data, error } = await supabase
      .from('activity_events')
      .select(`
        id, created_at, activity_type,
        fragrance_id, fragrance_brand, fragrance_name,
        target_url, metadata,
        profiles ( username, display_name, full_name, avatar_url )
      `)
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[CommunityPulse] activity_events query failed:', error.message);
      return [];
    }
    return (data || []).map(formatActivityItem);
  } catch (err) {
    console.warn('[CommunityPulse] unexpected error:', err.message);
    return [];
  }
}

/**
 * Fetch activity for a specific fragrance (detail page).
 * @param {string} brand
 * @param {string} name
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function getFragranceActivity(brand, name, limit = 5) {
  if (!brand && !name) return [];
  try {
    let query = supabase
      .from('activity_events')
      .select(`
        id, created_at, activity_type,
        fragrance_brand, fragrance_name,
        metadata,
        profiles ( username, display_name, full_name, avatar_url )
      `)
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (brand) query = query.ilike('fragrance_brand', brand);
    if (name)  query = query.ilike('fragrance_name', name);

    const { data, error } = await query;
    if (error) {
      console.warn('[CommunityPulse] fragrance activity query failed:', error.message);
      return [];
    }
    return (data || []).map(formatActivityItem);
  } catch (err) {
    console.warn('[CommunityPulse] unexpected error:', err.message);
    return [];
  }
}

/**
 * Fetch aggregate community stats for a fragrance detail page.
 * Returns counts for ratings, comments, collections, and recent ratings (last 7 days).
 * @param {string} brand
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function getFragranceCommunityStats(brand, name) {
  if (!brand && !name) return null;
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('activity_events')
      .select('activity_type, created_at')
      .eq('is_public', true)
      .ilike('fragrance_brand', brand || '')
      .ilike('fragrance_name', name || '');

    if (error) {
      console.warn('[CommunityPulse] stats query failed:', error.message);
      return null;
    }

    const rows = data || [];
    const stats = {
      ratings:        rows.filter(r => r.activity_type === 'rating').length,
      comments:       rows.filter(r => r.activity_type === 'comment' || r.activity_type === 'review').length,
      collections:    rows.filter(r => r.activity_type === 'collection_add').length,
      recentRatings:  rows.filter(r => r.activity_type === 'rating' && r.created_at >= weekAgo).length,
    };

    if (!stats.ratings && !stats.comments && !stats.collections) return null;
    return stats;
  } catch (err) {
    console.warn('[CommunityPulse] stats unexpected error:', err.message);
    return null;
  }
}

/**
 * Fetch lightweight community signals for a list of fragrances (search results).
 * Returns a map keyed by "brand|||name" (lowercased) → { ratingCount, topRater }
 * @param {Array<{brand:string, name:string}>} fragrances
 * @returns {Promise<Map>}
 */
export async function getSearchActivityStats(fragrances) {
  if (!fragrances || !fragrances.length) return new Map();
  try {
    // Limit to 20 to keep query lightweight
    const subset = fragrances.slice(0, 20);
    const names = subset.map(f => f.name).filter(Boolean);

    const { data, error } = await supabase
      .from('activity_events')
      .select(`
        fragrance_brand, fragrance_name, activity_type, created_at,
        profiles ( username, display_name )
      `)
      .eq('is_public', true)
      .eq('activity_type', 'rating')
      .in('fragrance_name', names)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.warn('[CommunityPulse] search stats query failed:', error.message);
      return new Map();
    }

    const map = new Map();
    for (const row of (data || [])) {
      const key = `${(row.fragrance_brand || '').toLowerCase()}|||${(row.fragrance_name || '').toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, { ratingCount: 0, topRater: null });
      }
      const entry = map.get(key);
      entry.ratingCount++;
      if (!entry.topRater && row.profiles) {
        entry.topRater = safeDisplayName(row.profiles);
      }
    }
    return map;
  } catch (err) {
    console.warn('[CommunityPulse] search stats unexpected error:', err.message);
    return new Map();
  }
}

/**
 * Format a raw activity_events row into a display object.
 * @param {object} row
 * @returns {object}
 */
export function formatActivityItem(row) {
  const profile = row.profiles || null;
  const actor = safeDisplayName(profile);
  const avatarUrl = safeAvatarUrl(profile);
  const labelFn = ACTIVITY_LABELS[row.activity_type];
  const action = labelFn ? labelFn(row) : `did something with ${_fragName(row)}`;

  let url = row.target_url || null;
  if (!url && row.fragrance_brand && row.fragrance_name) {
    url = `fragrance.html?brand=${encodeURIComponent(row.fragrance_brand)}&name=${encodeURIComponent(row.fragrance_name)}`;
  }

  return {
    id: row.id,
    actor,
    avatarUrl,
    action,
    activityType: row.activity_type,
    fragranceBrand: row.fragrance_brand,
    fragranceName: row.fragrance_name,
    url,
    createdAt: row.created_at,
    metadata: row.metadata || {},
  };
}

/**
 * Format a relative timestamp: "2 hours ago", "just now", etc.
 * @param {string} isoString
 * @returns {string}
 */
export function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(isoString).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ─── Avatar HTML helper ──────────────────────────────────────────────────────

/**
 * Build a small avatar element: photo if available, else coloured initial.
 * @param {string|null} avatarUrl
 * @param {string} actor  e.g. "@scentlover"
 * @returns {string} HTML string
 */
export function avatarHtml(avatarUrl, actor) {
  const initial = actor && actor.length > 1
    ? actor.replace('@', '').charAt(0).toUpperCase()
    : '?';
  if (avatarUrl) {
    return `<img class="cp-avatar" src="${avatarUrl}" alt="${initial}" loading="lazy">`;
  }
  // Generate a deterministic hue from the actor name for colour diversity
  let hue = 38; // gold default
  for (let i = 0; i < actor.length; i++) hue = (hue + actor.charCodeAt(i) * 7) % 360;
  return `<div class="cp-avatar cp-avatar-initial" style="--av-hue:${hue}">${initial}</div>`;
}
