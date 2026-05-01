import React, { useState, useEffect } from 'react';
import { SECTIONS } from './constants';

export default function DashboardNav() {
  const [active, setActive] = useState(SECTIONS[0]?.id || '');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0.1 }
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav style={{
      position: 'sticky',
      top: 0,
      zIndex: 30,
      background: 'rgba(255,255,255,0.95)',
      backdropFilter: 'blur(8px)',
      borderBottom: '1px solid #e5e7eb',
      padding: '8px 0',
      marginBottom: '24px',
    }}>
      <div style={{ display: 'flex', gap: '4px', overflowX: 'auto', padding: '0 4px' }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => scrollTo(s.id)}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              background: active === s.id ? '#3b82f6' : 'transparent',
              color: active === s.id ? 'white' : '#6b7280',
              fontWeight: active === s.id ? 700 : 500,
              fontSize: '13px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
