import type { TrovecInstance, Trovec } from './types.js';
import { add, addMany, get, del } from './collection.js';
import { query } from './query.js';
import { flush, close, stats } from './core.js';
import { embed, embedMany, addWithText, addManyWithText, queryByText } from './embedder.js';
import { serialize, deserialize } from './serialization.js';

export function wrapInstance(instance: TrovecInstance): Trovec {
  const wrapped = instance as Trovec;

  // Collection
  wrapped.add = (entry) => add(wrapped, entry);
  wrapped.addMany = (entries) => addMany(wrapped, entries);
  wrapped.get = (id) => get(wrapped, id);
  wrapped.delete = (id) => del(wrapped, id);

  // Query
  wrapped.query = (params) => query(wrapped, params);

  // Core
  wrapped.stats = () => stats(wrapped);
  wrapped.flush = () => flush(wrapped);
  wrapped.close = () => close(wrapped);

  // Embedder
  wrapped.embed = (input) => embed(wrapped, input);
  wrapped.embedMany = (input) => embedMany(wrapped, input);
  wrapped.addWithText = (entry) => addWithText(wrapped, entry);
  wrapped.addManyWithText = (entries) => addManyWithText(wrapped, entries);
  wrapped.queryByText = (params) => queryByText(wrapped, params);

  // Serialization
  wrapped.serialize = () => serialize(wrapped);
  wrapped.deserialize = (buffer) => deserialize(buffer, wrapped);

  return wrapped;
}
