// Deliberately outside the live root functions directory until release review.
import { handleApi } from '../../../server/api.js';
export function onRequest(context) { return handleApi(context.request, context.env, context); }
