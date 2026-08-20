"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("./src/config/db");
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield db_1.pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS suscripcion_plan VARCHAR(20) DEFAULT \'ninguno\'');
            console.log('Exito');
            process.exit(0);
        }
        catch (e) {
            console.error(e);
            process.exit(1);
        }
    });
}
run();
