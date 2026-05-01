import React from 'react';
import { CONTACT_IDS, CONTACT_META } from '../../context/SimugramContext';
import './simugram.css';

const CONTACT_ORDER = [CONTACT_IDS.BOSS, CONTACT_IDS.TUTOR, CONTACT_IDS.PM, CONTACT_IDS.LAWYER];

function stripMd(s) {
  if (!s || typeof s !== 'string') return s || '';
  return s
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function truncate(s, n) {
  if (!s) return '';
  const clean = stripMd(s);
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

function formatTime(ts) {
  if (!ts) return '';
  if (typeof ts === 'string' && /^\d{1,2}:\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return typeof ts === 'string' ? ts : '';
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export default function SimugramContactList({
  availableContacts,
  unreadCounts,
  lastMessages,
  onSelect,
  avatarUrls,
}) {
  const visible = CONTACT_ORDER.filter((id) => availableContacts.includes(id));

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {visible.map((id) => {
        const meta = CONTACT_META[id];
        const unread = unreadCounts?.[id] || 0;
        const last = lastMessages?.[id];
        const avatarUrl = avatarUrls?.[id];

        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={`simugram-contact-item${unread > 0 ? ' simugram-contact-item--unread' : ''}`}
          >
            <div className="simugram-avatar" style={{ background: meta.color, ...(avatarUrl ? { fontSize: 0 } : {}) }}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="" />
              ) : (
                meta.avatar || meta.name.charAt(0)
              )}
            </div>
            <div className="simugram-contact-main">
              <div className="simugram-contact-head">
                <div className="simugram-contact-head-row">
                  <span className="simugram-contact-name">{meta.name}</span>
                  <span className="simugram-contact-time">
                    {last?.time ? formatTime(last.time) : ''}
                  </span>
                </div>
                <div className="simugram-contact-role">{meta.subtitle}</div>
              </div>
              <div className="simugram-contact-bottomline">
                <span
                  className="simugram-contact-preview"
                >
                  {last?.text ? truncate(last.text, 40) : ''}
                </span>
                {unread > 0 && (
                  <span
                    className="simugram-unread-badge"
                    style={{ marginLeft: 6 }}
                    aria-label={`Непрочитанных сообщений: ${unread}`}
                  >
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
