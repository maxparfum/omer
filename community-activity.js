// community-activity.js — Community Pulse helper for MaxParfum
// Queries community_activity_feed view (backed by activity_events + public.users).
// Never queries profiles. All user fields come from the view.

import { supabase } from './supabase.js';

// ─── Activity type labels ────────────────────────────────────────────────────

function _fragName(row) {
  const brand = row.fragrance_brand || (row.metadata && row.metadata.fragrance_brand);
  const name  = row.fragrance_name  || (row.metadata && row.metadata.fragrance_name);
  if (brand && name)  return `${brand} ${name}`;
  if (name)           return name;
  if (brand)          return brand;
  return 'a fragrance';
}

function _stars(row) {
  const v = (row.metadata && (row.metadata.rating ?? row.metadata.rating_value));
  if (v == null || v === '') return '';
  return `${parseFloat(v).toFixed(1)} stars`;
}

function _scentleGuesses(row) {
  const g = row.metadata && (row.metadata.guesses_count ?? row.metadata.guesses);
  if (!g) return '';
  return ` in ${g} ${g === 1 ? 'guess' : 'guesses'}`;
}

function _forumTitle(row, prefix) {
  const title = row.metadata && (row.metadata.thread_title || row.metadata.title);
  if (title) return `${prefix}: ${title}`;
  return prefix.toLowerCase();
}

const ACTIVITY_LABELS = {
  rating:          (r) => { const s = _stars(r); return `rated ${_fragName(r)}${s ? ' ' + s : ''}`; },
  review:          (r) => `reviewed ${_fragName(r)}`,
  collection_add:  (r) => `added ${_fragName(r)} to their collection`,
  battle_vote:     (_) => `played Fragrance Battle`,
  forum_thread:    (r) => _forumTitle(r, 'started a discussion'),
  forum_reply:     (r) => _forumTitle(r, 'replied to'),
  scentle_complete:(r) => `completed today's Scentle${_scentleGuesses(r)}`,
};

// ─── Display name / avatar helpers ──────────────────────────────────────────

function safeDisplayName(row) {
  const name = row.username || row.display_name;
  if (name) return '@' + name.replace(/^@/, '');
  return 'A MaxParfum member';
}

export function avatarHtml(avatarUrl, actor) {
  const initial = actor && actor.length > 1
    ? actor.replace('@', '').charAt(0).toUpperCase()
    : '?';
  if (avatarUrl) {
    return `<img class="cp-avatar" src="${avatarUrl}" alt="${initial}" loading="lazy">`;
  }
  let hue = 38;
  for (let i = 0; i < actor.length; i++) hue = (hue + actor.charCodeAt(i) * 7) % 360;
  return `<div class="cp-avatar cp-avatar-initial" style="--av-hue:${hue}">${initial}</div>`;
}

// ─── Format a view row into a display object ─────────────────────────────────

export function formatActivityItem(row) {
  const actor    = safeDisplayName(row);
  const avatarUrl= row.avatar_url || null;
  const labelFn  = ACTIVITY_LABELS[row.activity_type];
  const action   = labelFn ? labelFn(row) : `did something with ${_fragName(row)}`;

  let url = row.target_url || null;
  if (!url && row.fragrance_brand && row.fragrance_name) {
    url = `fragrance.html?brand=${encodeURIComponent(row.fragrance_brand)}&name=${encodeURIComponent(row.fragrance_name)}`;
  }

  return {
    id:             row.id,
    actor,
    avatarUrl,
    action,
    activityType:   row.activity_type,
    fragranceBrand: row.fragrance_brand,
    fragranceName:  row.fragrance_name,
    url,
    createdAt:      row.created_at,
    metadata:       row.metadata || {},
  };
}

// ─── Relative timestamp ───────────────────────────────────────────────────────

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

// ─── Public query functions ───────────────────────────────────────────────────

/**
 * Fetch recent public activity for the homepage Community Pulse section.
 */
export async function getCommunityPulse(limit = 12) {
  try {
    const { data, error } = await supabase
      .from('community_activity_feed')
      .select('*')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[CommunityPulse] query failed:', error.message);
      return [];
    }
    return (data || []).map(formatActivityItem);
  } catch (err) {
    console.warn('[CommunityPulse] unexpected error:', err.message);
    return [];
  }
}

/**
 * Fetch activity feed for a specific fragrance (detail page).
 */
export async function getFragranceActivity(brand, name, limit = 5) {
  if (!brand && !name) return [];
  try {
    let query = supabase
      .from('community_activity_feed')
      .select('*')
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
 */
export async function getFragranceCommunityStats(brand, name) {
  if (!brand && !name) return null;
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('community_activity_feed')
      .select('activity_type, created_at')
      .eq('is_public', true);

    if (brand) query = query.ilike('fragrance_brand', brand);
    if (name)  query = query.ilike('fragrance_name', name);

    const { data, error } = await query;
    if (error) {
      console.warn('[CommunityPulse] stats query failed:', error.message);
      return null;
    }

    const rows = data || [];
    const stats = {
      ratings:       rows.filter(r => r.activity_type === 'rating').length,
      comments:      rows.filter(r => r.activity_type === 'review').length,
      collections:   rows.filter(r => r.activity_type === 'collection_add').length,
      recentRatings: rows.filter(r => r.activity_type === 'rating' && r.created_at >= weekAgo).length,
    };

    if (!stats.ratings && !stats.comments && !stats.collections) return null;
    return stats;
  } catch (err) {
    console.warn('[CommunityPulse] stats unexpected error:', err.message);
    return null;
  }
}

/**
 * Fetch lightweight community signals for search result cards.
 * Returns a Map keyed by "brand|||name" (lowercased) → { ratingCount, topRater }
 */
export async function getSearchActivityStats(fragrances) {
  if (!fragrances || !fragrances.length) return new Map();
  try {
    const subset = fragrances.slice(0, 20);
    const names  = subset.map(f => (f.name || '').toLowerCase()).filter(Boolean);
    if (!names.length) return new Map();

    const { data, error } = await supabase
      .from('community_activity_feed')
      .select('fragrance_brand, fragrance_name, activity_type, created_at, username, display_name')
      .eq('is_public', true)
      .eq('activity_type', 'rating')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.warn('[CommunityPulse] search stats query failed:', error.message);
      return new Map();
    }

    const map = new Map();
    for (const row of (data || [])) {
      const rowBrand = (row.fragrance_brand || '').toLowerCase();
      const rowName  = (row.fragrance_name  || '').toLowerCase();
      if (!rowName) continue;

      // Match against the requested fragrance list (case-insensitive in JS)
      const matched = subset.find(f =>
        (f.name  || '').toLowerCase() === rowName &&
        (!f.brand || (f.brand || '').toLowerCase() === rowBrand)
      );
      if (!matched) continue;

      const key = `${(matched.brand || '').toLowerCase()}|||${(matched.name || '').toLowerCase()}`;
      if (!map.has(key)) map.set(key, { ratingCount: 0, topRater: null });
      const entry = map.get(key);
      entry.ratingCount++;
      if (!entry.topRater) {
        const name = row.username || row.display_name;
        if (name) entry.topRater = '@' + name.replace(/^@/, '');
      }
    }
    return map;
  } catch (err) {
    console.warn('[CommunityPulse] search stats unexpected error:', err.message);
    return new Map();
  }
}
