// Registers the JSX loader for node:test. Kept separate so the loader itself
// stays a plain module that can be reasoned about on its own.
import {register} from 'node:module';

register('./jsx-loader.mjs', import.meta.url);
