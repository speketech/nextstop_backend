# Use a lightweight Node 18 image (matches your package.json engine)
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Set Node environment to production
ENV NODE_ENV=production

# Copy package.json and package-lock.json first (optimizes Docker caching)
COPY package*.json ./

# Install production dependencies only (skips devDependencies like nodemon and jest)
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "src/server.js"]