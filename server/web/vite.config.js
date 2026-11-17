export default {
  build: {
    // Emit every asset as a file: the server's CSP allows fonts and images from 'self', not data: URLs.
    assetsInlineLimit: 0,
    // Astryx themes are light-dark() pairs; an older target makes Lightning CSS rewrite them into a polyfill that ignores <Theme mode>.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    rolldownOptions: {
      onLog(level, log, handler) {
        // Astryx and lucide mark modules 'use client' for React Server Components; a client bundle has nothing to preserve.
        if (log.code === 'MODULE_LEVEL_DIRECTIVE') return;
        handler(level, log);
      },
    },
  },
};
