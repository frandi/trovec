import type { QuantizationType, QuantizationCodec } from '../types.js';
import { f32Codec } from './f32.js';
import { int8Codec } from './int8.js';
import { bitCodec } from './bit.js';

const codecs: Record<QuantizationType, QuantizationCodec> = {
  F32: f32Codec,
  INT8: int8Codec,
  BIT: bitCodec,
};

export function getCodec(type: QuantizationType): QuantizationCodec {
  return codecs[type];
}
