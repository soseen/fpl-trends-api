import fs from "fs";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers";
import { getBootstrapStaticData } from "./../fetch";
export const fetchBootstrapStatic = async () => {
    if (fs.existsSync(RAW_BOOTSTRAP_STATIC_FILE)) {
        fs.unlinkSync(RAW_BOOTSTRAP_STATIC_FILE);
    }
    try {
        const data = await getBootstrapStaticData();
        fs.writeFileSync(RAW_BOOTSTRAP_STATIC_FILE, JSON.stringify(data, null, 2));
    }
    catch (error) {
        console.error(`There was an error trying to fetch bootstrap static data...: ${error.message}`);
    }
};
