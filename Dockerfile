# Use an image that has Docker and Docker Compose pre-installed
FROM docker:24.0.7-dind

# Install dependencies needed for orchestration
RUN apk add --no-local-cache bash curl

# Set the working directory
WORKDIR /app

# Copy all project files into the container
COPY . .

# Expose the ports defined in your docker-compose.yml
# Nginx acts as your entry point on port 80
EXPOSE 80
EXPOSE 3000
EXPOSE 3001
EXPOSE 3003
EXPOSE 7880

# Use a shell script to start the docker daemon and then run compose
CMD ["sh", "-c", "dockerd-entrypoint.sh & sleep 5; docker-compose up --build"]