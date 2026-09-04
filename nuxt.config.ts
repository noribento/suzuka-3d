// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  ssr: false,
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'Suzuka 3D — F1 Japanese Grand Prix Live',
      htmlAttrs: { lang: 'ja' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'description', content: '3D Suzuka Circuit with 22 Formula 1 cars, broadcast-style graphics, built with Nuxt 4 and three.js.' },
        { name: 'theme-color', content: '#05060a' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Titillium+Web:ital,wght@0,400;0,600;0,700;0,900;1,700;1,900&family=Graduate&display=swap' },
      ],
    },
  },
  vite: {
    optimizeDeps: { include: ['three'] },
  },
  typescript: {
    strict: true,
  },
})
