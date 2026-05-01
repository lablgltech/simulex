/**
 * Плейсхолдеры в текстах кейса (письма, Simugram «Ирина Петровна»).
 * `{{deadline+N}}` → время HH:MM (база + N минут).
 * `baseDate` должен быть зафиксирован при входе на этап (одна и та же для всех плейсхолдеров этапа до конца сессии),
 * иначе при каждом вызове с `new Date()` время «плывёт».
 */
export function applyDeadlinePlaceholders(text, baseDate = new Date()) {
  if (text == null || typeof text !== 'string') return text;
  return text.replace(/\{\{deadline\+(\d+)\}\}/g, (_, min) => {
    const d = new Date(baseDate.getTime() + Number(min) * 60000);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  });
}
