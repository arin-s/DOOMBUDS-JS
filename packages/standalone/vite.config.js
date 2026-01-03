import basicSsl from '@vitejs/plugin-basic-ssl'
export default {
  plugins: [
    basicSsl(),
  ],
  base: "./",
  build: {
    target: "ES2020",
  },
  server: {
    host: '0.0.0.0'
  }
};
