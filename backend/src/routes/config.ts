import { Router } from 'express';
import { publicConfig } from '../config';

export const configRouter = Router();

configRouter.get('/config', (_req, res) => {
  res.status(200).json(publicConfig());
});
