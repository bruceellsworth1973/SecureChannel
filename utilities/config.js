const {config} = require('dotenv');
const {isEqual} = require('helpers');
const {platform, hostname} = require('os');
config({path: `${__dirname}/../.env`});
const win32 = isEqual(platform(), 'win32');
const [SERVER_ADDRESS] = hostname().split('.');
const NODE = win32 ? 'node.exe' : '/usr/bin/node';
const {USER, DRIVERS, SERVERIP, LOG_LEVELS} = process.env;
module.exports = {USER, DRIVERS, SERVER_ADDRESS, NODE, SERVERIP, LOG_LEVELS};
