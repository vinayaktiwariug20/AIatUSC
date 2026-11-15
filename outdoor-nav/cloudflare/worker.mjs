import graph from './graph.json' with { type: 'json' };
import gateData from '../data/gates.json' with { type: 'json' };
import {WalkRouter} from './router.mjs';
import {handleApi} from './api.mjs';

const context = {router: new WalkRouter(graph), gateData};
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    return path === '/api' || path.startsWith('/api/')
      ? handleApi(request, env, context)
      : env.ASSETS.fetch(request);
  },
};
