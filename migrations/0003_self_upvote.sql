-- Every post and comment now starts at score 1: the author's automatic upvote.
-- Bring existing content onto the same baseline.
UPDATE posts SET score = score + 1;
UPDATE comments SET score = score + 1;
