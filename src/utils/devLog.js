/** Лог только в development-сборке (CRA). */
export function devLog(...args) {
  if (process.env.NODE_ENV === 'development') {
    console.log(...args);
  }
}
