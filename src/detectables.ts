import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
// @ts-ignore
import type { Game, GameList } from 'arrpc';

export function getDetectablesPath() {
    const userDataPath = app.getPath("userData");
    const storagePath = path.join(userDataPath, "storage");
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }
    return path.join(storagePath, "detectables.json");
}

export function setDetectables(object: GameList): void {
    const toSave = JSON.stringify(object, null, 4);
    fs.writeFileSync(getDetectablesPath(), toSave, "utf-8");
}

export function addDetectable(object: Game): void {
    const currentDetectables = getDetectables();
    currentDetectables.push(object);
    setDetectables(currentDetectables);
}

export function getDetectables(): GameList {
    const p = getDetectablesPath();
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, "[]", "utf-8");
    }
    try {
        const rawData = fs.readFileSync(p, "utf-8");
        const returnData = JSON.parse(rawData) as GameList;
        console.log(`[Detectables] Loaded ${returnData.length} custom detectables`);
        return returnData;
    } catch (e) {
        console.error("Failed to load detectables:", e);
        return [];
    }
}
