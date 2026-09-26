import { applyTestEnv } from './test-env.js';

// Debe correr antes de que cualquier test importe src/config/env.ts.
applyTestEnv();
