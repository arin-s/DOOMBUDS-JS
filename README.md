# DOOMBUDS-JS
This monorepo contains five packages related to [DOOMBUDS](https://doombuds.com)
- `client` - A static site that lets the user join a queue provided by `webserver`, sends keypress events and displays an MJPEG or twitch stream.
- `webserver` - Serves assets from `client`, manages the player queue, forwards socket.io events between the user and `serialserver`
- `serialserver` - Connects to the doombuds locally and forwards its packets to/from `webserver`. Also transcodes and streams the video to twitch.tv.
- `standalone` - interact with the earbuds connected via USB. Only works with chromium-based browsers
- `common` - common code shared between the above packages

Currently there are only build instructions for the `standalone` package.  
## Standalone package
If you've flashed DOOMBUDS onto your Pinebuds Pro earbuds, this package will allow you to connect to them and play the game through your browser.  
It's not necessary to build the standalone package, you can access a pre-built version [here](https://arin-s.github.io/DOOMBUDS-JS/).
### Build 
1. Run `git clone https://github.com/arin-s/DOOMBUDS-JS`
2. Run `cd DOOMBUDS-JS`
3. Run `npm run standalone:dev`
4. Paste the link outputted in the console into your browser
### Usage  
1. Either build the package yourself using the instructions above, or access the pre-built version [here](https://arin-s.github.io/DOOMBUDS-JS/).  
2. Make sure the earbuds are seated firmly in their case and then plug the case into your PC.
3. Click 'connect' and select a serial port.  
If you pick the wrong one, reload the page and try again, the disconnect button is a lie.  
Make sure you are using a chromium-based browser, Firefox and Safari do not support the Web Serial API and thus will fail to open the serial connection.

The 'use polyfill' checkbox is experimental and enables functionality on _some_ Android devices, however there are no touch controls at the moment so you'll need to use a bluetooth keyboard.

https://github.com/user-attachments/assets/e00f58e9-0118-4975-a332-1baa0c0fae2b

