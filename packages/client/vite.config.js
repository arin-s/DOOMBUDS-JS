import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import path from 'path';
export default defineConfig(({mode, command}) => {
  const loadedEnvs = loadEnv(mode, path.resolve(import.meta.dirname, '..', '..'), '');
  const envs = ['WEBSERVER_DOMAIN_NAME', 'TWITCH_CHANNEL'];
  for (const env of envs) {
    if (!loadedEnvs[env])
      throw new Error(`Environment variable '${env}' is required!`);
  }
  const defines = {};
  for (const env of envs) {
    defines[`import.meta.env.${env}`] = JSON.stringify(loadedEnvs[env]);
  }
  return {
    base: './',
    build: {
      target: 'ES2020',
    },
    server: {
      host: '0.0.0.0',
      port: '8080',
      allowedHosts: [`${loadedEnvs['WEBSERVER_DOMAIN_NAME']}`],
    },
    define: defines,
    plugins: [
      tailwindcss(),
    ],
  };
});
