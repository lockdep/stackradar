import type { Request, Response, NextFunction } from "express";
import { prometheusService } from "../services/prometheus.service.js";

export const prometheusController = {
    async scrape(_req: Request, res: Response, next: NextFunction) {
        try {
            const body = await prometheusService.collect();
            res.setHeader("Content-Type", prometheusService.contentType);
            res.send(body);
        } catch (error) {
            next(error);
        }
    },
};
