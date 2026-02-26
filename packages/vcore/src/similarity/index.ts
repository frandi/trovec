import type { MetricType, SimilarityFn } from '../types.js';
import { cosineSimilarity } from './cosine.js';
import { euclideanSimilarity } from './euclidean.js';
import { dotSimilarity } from './dot.js';
import { hammingSimilarity } from './hamming.js';

const metrics: Record<MetricType, SimilarityFn> = {
  cosine: cosineSimilarity,
  euclidean: euclideanSimilarity,
  dot: dotSimilarity,
  hamming: hammingSimilarity,
};

export function getMetric(metric: MetricType): SimilarityFn {
  return metrics[metric];
}
