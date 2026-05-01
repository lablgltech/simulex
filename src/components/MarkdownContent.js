import React from 'react';

/**
 * Парсинг инлайн-разметки в строке: **жирный**, *курсив*
 * Приоритет у ** (двойные звёздочки), затем *
 */
function parseInlineMarkdown(str) {
  if (!str || typeof str !== 'string') return [{ type: 'text', content: str || '' }];
  const parts = [];
  let s = str;

  while (s.length > 0) {
    const idxLink = s.indexOf('[');
    const idxBold = s.indexOf('**');
    const idxItalic = s.indexOf('*');

    const useLink = idxLink >= 0 && (() => {
      const afterBracket = s.slice(idxLink + 1);
      const closeBracket = afterBracket.indexOf(']');
      if (closeBracket < 0) return false;
      const afterClose = afterBracket.slice(closeBracket + 1);
      return afterClose.startsWith('(') && afterClose.indexOf(')') >= 0;
    })() && (idxBold < 0 || idxLink < idxBold) && (idxItalic < 0 || idxLink < idxItalic);

    if (useLink) {
      const afterBracket = s.slice(idxLink + 1);
      const closeBracket = afterBracket.indexOf(']');
      const linkText = afterBracket.slice(0, closeBracket);
      const afterClose = afterBracket.slice(closeBracket + 1);
      const closeParen = afterClose.indexOf(')');
      const linkUrl = afterClose.slice(1, closeParen);
      if (idxLink > 0) parts.push({ type: 'text', content: s.slice(0, idxLink) });
      parts.push({ type: 'link', content: linkText, url: linkUrl });
      s = afterClose.slice(closeParen + 1);
      continue;
    }

    const useBold = idxBold >= 0 && (idxItalic < 0 || idxBold <= idxItalic) && (!useLink);
    const useItalic = idxItalic >= 0 && !useBold && (idxItalic + 1 < s.length && s[idxItalic + 1] !== '*') && (!useLink);

    if (useBold) {
      const afterOpen = s.slice(idxBold + 2);
      const closeIdx = afterOpen.indexOf('**');
      if (closeIdx >= 0) {
        if (idxBold > 0) parts.push({ type: 'text', content: s.slice(0, idxBold) });
        parts.push({ type: 'bold', content: afterOpen.slice(0, closeIdx) });
        s = afterOpen.slice(closeIdx + 2);
        continue;
      }
    }
    if (useItalic) {
      const afterOpen = s.slice(idxItalic + 1);
      const closeIdx = afterOpen.indexOf('*');
      if (closeIdx >= 0) {
        if (idxItalic > 0) parts.push({ type: 'text', content: s.slice(0, idxItalic) });
        parts.push({ type: 'italic', content: afterOpen.slice(0, closeIdx) });
        s = afterOpen.slice(closeIdx + 1);
        continue;
      }
    }
    parts.push({ type: 'text', content: s });
    break;
  }

  return parts.length > 0 ? parts : [{ type: 'text', content: str }];
}

/**
 * Компонент для отображения Markdown контента
 * Использует простой парсинг для базовых элементов Markdown
 *
 * @param {'document'|'ui'} variant — `document`: класс simulex-content (--font-reading);
 *   `ui`: simulex-markdown-ui (--font-ui), для чата Simugram и подсказок тура.
 */
export default function MarkdownContent({ content, className = '', variant = 'document' }) {
  if (!content) return null;

  const renderInline = (str) => {
    const parts = parseInlineMarkdown(str);
    return parts.map((p, i) => {
      if (p.type === 'bold') return <strong key={i}>{p.content}</strong>;
      if (p.type === 'italic') return <em key={i}>{p.content}</em>;
      if (p.type === 'link') {
        const isSimugram = p.url.startsWith('simugram:');
        const isAction = p.url.startsWith('simugram:action:');
        const simugramStyle = isSimugram ? {
          color: '#2563eb',
          textDecoration: 'underline',
          textDecorationStyle: 'dotted',
          cursor: 'pointer',
          fontWeight: 500,
        } : undefined;
        if (isAction) {
          const rest = p.url.slice('simugram:action:'.length);
          const sepIdx = rest.indexOf(':');
          const action = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
          const payload = sepIdx >= 0 ? rest.slice(sepIdx + 1) : undefined;
          return (
            <a key={i} href="#" data-simugram-action={action} data-simugram-payload={payload}
              onClick={(e) => e.preventDefault()} style={simugramStyle}>{p.content}</a>
          );
        }
        return (
          <a
            key={i}
            href={isSimugram ? '#' : p.url}
            data-simugram-contact={isSimugram ? p.url.slice('simugram:'.length) : undefined}
            onClick={isSimugram ? (e) => e.preventDefault() : undefined}
            style={simugramStyle}
          >
            {p.content}
          </a>
        );
      }
      return <React.Fragment key={i}>{p.content}</React.Fragment>;
    });
  };

  // Простой парсер Markdown для базовых элементов
  const parseMarkdown = (text) => {
    const lines = text.split('\n');
    const elements = [];
    let currentParagraph = [];
    let inList = false;
    let listItems = [];

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        elements.push({
          type: 'paragraph',
          content: currentParagraph.join(' ')
        });
        currentParagraph = [];
      }
    };

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push({
          type: 'list',
          items: listItems
        });
        listItems = [];
        inList = false;
      }
    };

    const isTableRow = (s) => /^\|.+\|$/.test(s) && s.includes('|');
    const isTableSeparator = (s) => /^\|[\s\-:]+\|/.test(s) && s.split('|').length >= 2;
    const parseTableRow = (s) => s.split('|').slice(1, -1).map((c) => c.trim());
    let tableRows = [];

    const flushTable = () => {
      if (tableRows.length > 0) {
        const separatorIdx = tableRows.findIndex((row) => isTableSeparator(row));
        let header = [];
        let body = [];
        if (separatorIdx >= 0) {
          header = tableRows.slice(0, separatorIdx).map(parseTableRow);
          body = tableRows.slice(separatorIdx + 1).map(parseTableRow).filter((r) => r.some((c) => c));
        } else {
          body = tableRows.map(parseTableRow);
        }
        if (header.length > 0 || body.length > 0) {
          elements.push({
            type: 'table',
            header: header.length > 0 ? header[0] : null,
            rows: body
          });
        }
        tableRows = [];
      }
    };

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      
      // Заголовки (от большего числа # к меньшему, чтобы «##» не съелось как «#»)
      if (trimmed.startsWith('##### ')) {
        flushParagraph();
        flushList();
        flushTable();
        elements.push({
          type: 'h5',
          content: trimmed.substring(6)
        });
      } else if (trimmed.startsWith('#### ')) {
        flushParagraph();
        flushList();
        flushTable();
        elements.push({
          type: 'h4',
          content: trimmed.substring(5)
        });
      } else if (trimmed.startsWith('### ')) {
        flushParagraph();
        flushList();
        flushTable();
        elements.push({
          type: 'h3',
          content: trimmed.substring(4)
        });
      } else if (trimmed.startsWith('## ')) {
        flushParagraph();
        flushList();
        flushTable();
        elements.push({
          type: 'h2',
          content: trimmed.substring(3)
        });
      } else if (trimmed.startsWith('# ')) {
        flushParagraph();
        flushList();
        flushTable();
        elements.push({
          type: 'h1',
          content: trimmed.substring(2)
        });
      }
      // Строка таблицы (начинается с |)
      else if (isTableRow(trimmed)) {
        flushParagraph();
        flushList();
        if (isTableSeparator(trimmed)) {
          tableRows.push(trimmed);
        } else {
          tableRows.push(trimmed);
        }
      }
      // Списки
      else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        flushParagraph();
        flushTable();
        if (!inList) {
          inList = true;
        }
        listItems.push(trimmed.substring(2));
      }
      // Пустая строка
      else if (trimmed === '') {
        flushParagraph();
        flushList();
        flushTable();
      }
      // Обычный текст
      else {
        flushList();
        flushTable();
        currentParagraph.push(trimmed);
      }
    });

    flushParagraph();
    flushList();
    flushTable();

    return elements;
  };

  const elements = parseMarkdown(content);
  const presetClass = variant === 'ui' ? 'simulex-markdown-ui' : 'simulex-content';
  const rootClass = [presetClass, className].filter(Boolean).join(' ');

  return (
    <div className={rootClass} style={{ lineHeight: '1.8', color: '#374151' }}>
      {elements.map((element, index) => {
        switch (element.type) {
          case 'h1':
            return (
              <h1 key={index} style={{ 
                fontSize: '24px', 
                fontWeight: 'bold', 
                marginTop: '20px', 
                marginBottom: '12px',
                color: '#1f2937'
              }}>
                {renderInline(element.content)}
              </h1>
            );
          case 'h2':
            return (
              <h2 key={index} style={{ 
                fontSize: '20px', 
                fontWeight: 'bold', 
                marginTop: '16px', 
                marginBottom: '10px',
                color: '#374151'
              }}>
                {renderInline(element.content)}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={index} style={{ 
                fontSize: '18px', 
                fontWeight: '600', 
                marginTop: '12px', 
                marginBottom: '8px',
                color: '#4b5563'
              }}>
                {renderInline(element.content)}
              </h3>
            );
          case 'h4':
            return (
              <h4 key={index} style={{
                fontSize: '16px',
                fontWeight: 600,
                marginTop: '10px',
                marginBottom: '6px',
                color: '#4b5563'
              }}>
                {renderInline(element.content)}
              </h4>
            );
          case 'h5':
            return (
              <h5 key={index} style={{
                fontSize: '15px',
                fontWeight: 600,
                marginTop: '8px',
                marginBottom: '6px',
                color: '#6b7280'
              }}>
                {renderInline(element.content)}
              </h5>
            );
          case 'paragraph':
            return (
              <p key={index} style={{ 
                marginBottom: '12px',
                lineHeight: '1.7'
              }}>
                {renderInline(element.content)}
              </p>
            );
          case 'list':
            return (
              <ul key={index} style={{ 
                marginBottom: '12px',
                paddingLeft: '20px',
                listStyleType: 'disc'
              }}>
                {element.items.map((item, itemIndex) => (
                  <li key={itemIndex} style={{ marginBottom: '6px' }}>
                    {renderInline(item)}
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={index} style={{ marginBottom: '16px', overflowX: 'auto' }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '14px',
                  color: '#374151'
                }}>
                  {element.header && element.header.length > 0 && (
                    <thead>
                      <tr>
                        {element.header.map((cell, i) => (
                          <th key={i} style={{
                            border: '1px solid #e5e7eb',
                            padding: '10px 12px',
                            textAlign: 'left',
                            fontWeight: 600,
                            background: '#f9fafb'
                          }}>
                            {renderInline(cell)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {element.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} style={{
                            border: '1px solid #e5e7eb',
                            padding: '10px 12px'
                          }}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
