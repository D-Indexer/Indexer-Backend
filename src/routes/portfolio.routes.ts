import { Router } from 'express';
import { createPortfolioController } from '../controllers/portfolio.controller';
import type { PortfolioService } from '../services/portfolio.service';

export interface PortfolioRoutesDeps {
  portfolioService: PortfolioService;
}

export function createPortfolioRoutes(deps: PortfolioRoutesDeps): Router {
  const router = Router();
  const ctrl = createPortfolioController({ portfolioService: deps.portfolioService });

  router.get('/:address', ctrl.getByAddress);

  return router;
}

export default createPortfolioRoutes;