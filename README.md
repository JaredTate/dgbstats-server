### DGB Stats Server

DigiByte Stats server codebase. Three things are needed to run the DGB stats site: dgbstats, dgbstats-server & digibyted.

### Set up the project

1. Clone the repository:

```
git clone https://github.com/JaredTate/dgbstats.git
```

2. Change to the project directory:

```
cd dgbstats-server
```

3. Install Node & the dependencies:

```
sudo apt update
sudo apt install nodejs
node -v
npm -v
sudo npm install -g n
sudo n install 21.7.2
sudo n use 21.7.2
npm install
```

## Running the Application

1. Start the backend server inside /dgbstats-server:

```
sudo npm start
```